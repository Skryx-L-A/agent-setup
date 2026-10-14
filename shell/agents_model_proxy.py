#!/usr/bin/env python3
"""Run-bound Unix-socket HTTP proxy for Agents model transports."""

from __future__ import annotations

import base64
import binascii
import http.client
import ipaddress
import json
import math
import os
import re
import socket
import socketserver
import ssl
import stat
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urlsplit


MAX_REQUEST_BYTES = 8 * 1024 * 1024
DEFAULT_IO_TIMEOUT = 300.0
STREAM_CHUNK_BYTES = 64 * 1024
ROUTES = {
    "anthropic-messages": "/v1/messages?beta=true",
    "openai-responses": "/v1/responses",
    # Chat-Completions fuer lokale Inferenzserver (Ollama, llama.cpp), die Pi mit openai-completions spricht.
    "openai-completions": "/v1/chat/completions",
}
CODEX_UPSTREAM_PATH = "/backend-api/codex/responses"
# Der Geheimnisfilter bindet seine Route `chatgpt` bereits auf `/backend-api`. Der Modellproxy
# darf hinter diesem Filterpraefix deshalb nur den verbleibenden Codex-Pfad anfragen.
CODEX_FILTER_UPSTREAM_PATH = "/codex/responses"
FORWARDED_REQUEST_HEADERS = frozenset(
    {"accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent"}
)
FORWARDED_RESPONSE_HEADERS = frozenset({"cache-control", "content-length", "content-type", "retry-after", "request-id"})
# Ratenlimit-Header tragen nur Zeiten, Anteile und Zustaende. Der Harness braucht sie, um
# ein erschoepftes Abo-Kontingent zu erkennen, statt blind zu wiederholen.
LIMIT_HEADER_PREFIX = "anthropic-ratelimit-"
CODEX_RESET_HEADERS = frozenset({"x-codex-primary-reset-after-seconds", "x-codex-primary-reset-at",
                                 "x-codex-secondary-reset-after-seconds", "x-codex-secondary-reset-at"})
LIMIT_STATUSES = frozenset({401, 403, 429, 529})
_LIMIT_VALUE = re.compile(r"[A-Za-z0-9 .:_,+-]{0,128}\Z")
REQUEST_FIELDS = {
    "anthropic-messages": frozenset({"model", "messages", "system", "max_tokens", "stream", "temperature",
                                      "thinking", "output_config", "tool_choice", "tools", "metadata",
                                      "context_management"}),
    "openai-responses": frozenset({"model", "input", "instructions", "stream", "tools", "tool_choice",
                                    "reasoning", "max_output_tokens", "temperature", "top_p", "text",
                                    "parallel_tool_calls", "previous_response_id", "include", "background",
                                    "store", "metadata", "truncation", "service_tier", "stream_options",
                                    "prompt_cache_key", "client_metadata"}),
    "openai-completions": frozenset({"model", "messages", "stream", "tools", "tool_choice", "temperature",
                                      "top_p", "max_tokens", "max_completion_tokens", "stream_options",
                                      "parallel_tool_calls", "response_format", "stop", "seed", "store"}),
}
ANTHROPIC_BETA_VALUES = frozenset({
    "oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,"
    "context-management-2025-06-27,prompt-caching-scope-2026-01-05",
    "oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,"
    "context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,"
    "thinking-display-updates-2026-08-18,extended-cache-ttl-2025-04-11",
})
OPENAI_CLIENT_TOOLS = frozenset({"function", "custom", "local_shell"})
OPENAI_WEB_TOOLS = frozenset({"web_search", "web_search_preview"})
ANTHROPIC_WEB_TOOL = re.compile(r"web_(?:search|fetch)(?:_[0-9]{8})?\Z")
HOP_BY_HOP_HEADERS = frozenset(
    {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"}
)
_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_MODEL_PATTERN = re.compile(r"[A-Za-z0-9._:/-]{1,512}\Z")
_HEADER_PATTERN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")
# Route des lokalen Geheimnisfilters (wb-geheimnis-filter, z. B. /anthropic): genau ein Pfadglied, nur vor einem
# numerischen Loopback-Ursprung ueber http. Jeder andere Pfad im Backend bleibt abgelehnt.
_FILTER_ROUTE = re.compile(r"/[a-z][a-z0-9-]{0,31}\Z")


class ModelProxyError(Exception):
    """Expected configuration, policy, or transport failure."""


_EFFORT_VALUES = frozenset({"low", "medium", "high", "xhigh", "max"})
_THINKING_TYPES = frozenset({"enabled", "adaptive", "disabled"})


def _forward_response_header(name: str, value: str) -> bool:
    lowered = name.lower()
    if lowered in FORWARDED_RESPONSE_HEADERS:
        return True
    return lowered.startswith(LIMIT_HEADER_PREFIX) and bool(_LIMIT_VALUE.fullmatch(value))


def _validate_model_id(value: object) -> None:
    # Opaque provider identifier; never interpret it as a filesystem path.
    if not isinstance(value, str) or not _MODEL_PATTERN.fullmatch(value):
        raise ModelProxyError("Invalid model identifier")


@dataclass(frozen=True)
class ProxyBinding:
    """Immutable identity selected by the controller."""

    world_id: str
    agent_id: str
    run_id: str
    provider: str
    model: str
    web: bool = False

    def __post_init__(self) -> None:
        for name, value in vars(self).items():
            if name == "web":
                if type(value) is not bool:
                    raise ModelProxyError("Invalid web binding")
                continue
            if name == "model":
                _validate_model_id(value)
                continue
            if not isinstance(value, str) or not _ID_PATTERN.fullmatch(value):
                raise ModelProxyError(f"Invalid binding field: {name}")


def _validate_tools(payload: dict[str, object], protocol: str, web: bool) -> str | None:
    """Return a safe error code before any upstream connection is opened."""
    if "tools" not in payload:
        return None
    tools = payload["tools"]
    if not isinstance(tools, list):
        return "invalid_tools"
    for tool in tools:
        if not isinstance(tool, dict):
            return "invalid_tools"
        kind = tool.get("type")
        if protocol == "anthropic-messages":
            if "type" not in tool and isinstance(tool.get("name"), str) and isinstance(tool.get("input_schema"), dict):
                continue
            if isinstance(kind, str) and ANTHROPIC_WEB_TOOL.fullmatch(kind):
                if web:
                    continue
                return "web_tool_not_allowed"
        elif protocol == "openai-responses":
            if isinstance(kind, str) and kind in OPENAI_CLIENT_TOOLS:
                continue
            if isinstance(kind, str) and kind in OPENAI_WEB_TOOLS:
                if web:
                    continue
                return "web_tool_not_allowed"
        elif protocol == "openai-completions":
            if kind == "function":
                continue
        return "server_tool_not_allowed"
    return None


def _validate_tool_choice(payload: dict[str, object], protocol: str, web: bool) -> str | None:
    if "tool_choice" not in payload:
        return None
    choice = payload["tool_choice"]
    if protocol == "anthropic-messages":
        if not isinstance(choice, dict) or set(choice) - {"type", "name", "disable_parallel_tool_use"}:
            return "tool_choice_not_allowed"
        kind = choice.get("type")
        if isinstance(kind, str) and kind in {"auto", "any", "none"} and "name" not in choice:
            return None
        if kind == "tool" and isinstance(choice.get("name"), str):
            return None
    else:
        if isinstance(choice, str) and choice in {"auto", "required", "none"}:
            return None
        if not isinstance(choice, dict):
            return "tool_choice_not_allowed"
        kind = choice.get("type")
        if protocol == "openai-responses":
            if isinstance(kind, str) and kind in OPENAI_CLIENT_TOOLS and set(choice) <= {"type", "name"}:
                return None
            if isinstance(kind, str) and kind in OPENAI_WEB_TOOLS and web and set(choice) == {"type"}:
                return None
        elif (protocol == "openai-completions" and kind == "function"
              and set(choice) <= {"type", "function"} and isinstance(choice.get("function"), dict)
              and isinstance(choice["function"].get("name"), str)):
            return None
    return "tool_choice_not_allowed"


class _DuplicateJSONKey(ValueError):
    pass


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJSONKey()
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> object:
    raise ValueError("Invalid JSON constant")


def _finite_json_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite JSON number")
    return number


def _content_url_allowed(value: object, web: bool) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    if parsed.scheme.lower() == "data":
        return True
    return web and parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)


def _fields(value: object, names: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) - set(names.split()):
        raise ValueError("unknown structure field")
    return value


def _kind(value: dict[str, object], forms: dict[str, str]) -> str:
    raw = value.get("type")
    if not isinstance(raw, str) or raw.lower() not in forms:
        raise ValueError("unknown structure type")
    # A differently cased known type receives exactly the same scrutiny.
    return raw.lower()


def _items(value: object, checker: Callable[[object], None]) -> None:
    if not isinstance(value, list):
        raise ValueError("expected list")
    for item in value:
        checker(item)


def _url(value: object, web: bool) -> None:
    if not _content_url_allowed(value, web):
        raise ValueError("remote content source not allowed")


def _inline_base64(value: object) -> None:
    if not isinstance(value, str):
        raise ValueError("invalid base64 source")
    try:
        base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("invalid base64 source") from None


def _file_id(value: object) -> None:
    if not isinstance(value, str) or not _ID_PATTERN.fullmatch(value):
        raise ValueError("invalid file id")


def _anthropic_source(value: object, web: bool) -> None:
    source = _fields(value, "type url media_type data file_id content")
    kind = _kind(source, {key: key for key in ("url", "base64", "file", "text", "content")})
    permitted = {
        "url": "type url", "base64": "type media_type data", "file": "type file_id",
        "text": "type media_type data", "content": "type content",
    }
    _fields(source, permitted[kind])
    if kind == "url":
        _url(source.get("url"), web)
    elif kind == "content":
        _items(source.get("content"), lambda block: _anthropic_block(block, web))
    elif kind == "base64":
        _inline_base64(source.get("data"))
    elif kind == "file":
        _file_id(source.get("file_id"))
    elif not isinstance(source.get("data"), str):
        raise ValueError("invalid inline text")


def _anthropic_web_result_content(content: object, kind: str, web: bool) -> None:
    """History of a server web search or fetch turn (replayed after pause_turn or in later turns).

    The error forms carry only a code. Result entries carry remote URLs as plain metadata the
    provider does not fetch again, but they exist only after a granted web tool, so they need web.
    A fetched document is checked like any document block, so its source still obeys the URL rule.
    """
    if kind == "web_search_tool_result" and isinstance(content, list):
        for entry in content:
            if isinstance(entry, dict) and entry.get("type") == "web_search_result":
                if not web:
                    raise ValueError("web search result needs web access")
                result = _fields(entry, "type url title encrypted_content page_age")
                for name in ("url", "title", "encrypted_content"):
                    if name in result:
                        _string(result[name])
                if result.get("page_age") is not None:
                    _string(result["page_age"])
            else:
                _anthropic_block(entry, web)
        return
    if isinstance(content, dict):
        entry = _fields(content, "type error_code url content retrieved_at")
        forms = {"web_search_tool_result_error": "", "web_fetch_tool_error": ""}
        if kind == "web_fetch_tool_result":
            forms["web_fetch_result"] = ""
        form = _kind(entry, forms)
        if form == "web_fetch_result":
            if not web:
                raise ValueError("web fetch result needs web access")
            _fields(entry, "type url content retrieved_at")
            _string(entry.get("url"))
            if "retrieved_at" in entry and entry["retrieved_at"] is not None:
                _string(entry["retrieved_at"])
            if "content" in entry:
                _anthropic_block(entry["content"], web)
        else:
            _fields(entry, "type error_code")
            _string(entry.get("error_code"))
        return
    if content is None or isinstance(content, str):
        raise ValueError("invalid web result content")
    _items(content, lambda part: _anthropic_block(part, web))


def _anthropic_block(value: object, web: bool) -> None:
    block = _fields(value, "type text citations cache_control source title content id name input tool_use_id is_error signature thinking data")
    kind = _kind(block, {key: key for key in (
        "text", "image", "document", "search_result", "tool_use", "tool_result",
        "server_tool_use", "web_search_tool_result", "web_fetch_tool_result",
        "thinking", "redacted_thinking")})
    forms = {
        "text": "type text citations cache_control", "image": "type source cache_control",
        "document": "type source title citations cache_control", "search_result": "type source title content citations cache_control",
        "tool_use": "type id name input cache_control", "tool_result": "type tool_use_id content is_error cache_control",
        "server_tool_use": "type id name input", "web_search_tool_result": "type tool_use_id content",
        "web_fetch_tool_result": "type tool_use_id content", "thinking": "type thinking signature",
        "redacted_thinking": "type data",
    }
    _fields(block, forms[kind])
    if kind in {"image", "document"}:
        _anthropic_source(block.get("source"), web)
    elif kind == "tool_result":
        # The API accepts an empty result: content is optional.
        content = block.get("content")
        if "content" in block and not isinstance(content, str):
            _items(content, lambda part: _anthropic_block(part, web))
        if "is_error" in block:
            _boolean(block["is_error"])
    elif kind in {"web_search_tool_result", "web_fetch_tool_result"}:
        _anthropic_web_result_content(block.get("content"), kind, web)
    elif kind == "search_result":
        if not isinstance(block.get("source"), str):
            raise ValueError("invalid citation source")
        _items(block.get("content"), lambda part: _anthropic_block(part, web))
    if "citations" in block:
        citations = block["citations"]
        if isinstance(citations, dict):
            _fields(citations, "enabled")
        else:
            _items(citations, lambda c: _anthropic_citation(c))
    if "cache_control" in block:
        _fields(block["cache_control"], "type ttl scope")


def _anthropic_citation(value: object) -> None:
    citation = _fields(value, "type url title encrypted_index cited_text document_index document_title start_char_index end_char_index start_page_number end_page_number start_block_index end_block_index")
    _kind(citation, {key: key for key in ("web_search_result_location", "char_location", "page_location", "content_block_location")})


def _responses_part(value: object, web: bool) -> None:
    part = _fields(value, "type text image_url file_url file_id file_data filename detail")
    kind = _kind(part, {key: key for key in ("input_text", "output_text", "input_image", "input_file")})
    forms = {"input_text": "type text", "output_text": "type text", "input_image": "type image_url file_id detail",
             "input_file": "type file_url file_id file_data filename"}
    _fields(part, forms[kind])
    for field in ("image_url", "file_url"):
        if field in part:
            _url(part[field], web)
    if "file_id" in part:
        _file_id(part["file_id"])
    if "file_data" in part and not _content_url_allowed(part["file_data"], False):
        raise ValueError("invalid inline file")


def _reasoning_item(item: dict[str, object]) -> None:
    """Replayed reasoning of an earlier turn. encrypted_content is opaque provider state: it is
    only a string here, and the item has no URL, file or tool field."""
    for name in ("id", "encrypted_content", "status"):
        if name in item and item[name] is not None:
            _string(item[name])
    for name, part_type in (("summary", "summary_text"), ("content", "reasoning_text")):
        if name in item:
            def check_part(value: object, part_type: str = part_type) -> None:
                part = _fields(value, "type text")
                if _kind(part, {part_type: part_type}) != part_type:
                    raise ValueError("unknown reasoning part")
                _string(part.get("text"))
            _items(item[name], check_part)


def _responses_item(value: object, web: bool) -> None:
    item = _fields(value, "type role content id status call_id name arguments input output action command pending_safety_checks acknowledgement phase encrypted tools summary encrypted_content")
    if "role" in item and "type" not in item:
        _fields(item, "role content")
        content = item.get("content")
        if not isinstance(content, str):
            _items(content, lambda part: _responses_part(part, web))
        return
    kind = _kind(item, {key: key for key in (
        "message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output",
        "local_shell_call", "local_shell_call_output", "computer_call_output", "additional_tools", "reasoning")})
    forms = {
        "message": "type role content id status phase encrypted", "function_call": "type call_id name arguments id status",
        "function_call_output": "type call_id output id status", "custom_tool_call": "type call_id name input id status",
        "custom_tool_call_output": "type call_id output id status", "local_shell_call": "type call_id action id status",
        "local_shell_call_output": "type call_id output id status", "computer_call_output": "type call_id output id status",
        "additional_tools": "type role id tools",
        "reasoning": "type id summary encrypted_content content status",
    }
    _fields(item, forms[kind])
    if kind == "message":
        content = item.get("content")
        if not isinstance(content, str):
            _items(content, lambda part: _responses_part(part, web))
        for field in ("phase", "encrypted"):
            if field in item:
                if field == "phase":
                    _string(item[field])
                elif not isinstance(item[field], (str, bool)):
                    raise ValueError("invalid encrypted marker")
    elif kind == "reasoning":
        _reasoning_item(item)
    elif kind == "additional_tools":
        if item.get("role") != "developer":
            raise ValueError("additional tools require developer role")
        _items(item.get("tools"), _responses_namespace)
    elif kind == "custom_tool_call":
        _string(item.get("input"))
    elif kind == "computer_call_output" and isinstance(item.get("output"), dict):
        screenshot = _fields(item["output"], "type image_url")
        if _kind(screenshot, {"computer_screenshot": "computer_screenshot"}) == "computer_screenshot":
            _url(screenshot.get("image_url"), web)
    elif kind.endswith("_output") and isinstance(item.get("output"), list):
        _items(item["output"], lambda part: _responses_part(part, web))
    elif kind.endswith("_output") and not isinstance(item.get("output"), str):
        raise ValueError("unknown output structure")
    elif kind == "local_shell_call" and "action" in item:
        _fields(item["action"], "type command timeout max_output_length")


def _custom_format(value: object) -> None:
    """Free-form tool input format: documented flat grammar form, or the grammar nested form."""
    fmt = _fields(value, "type syntax definition grammar")
    if _kind(fmt, {"text": "", "grammar": ""}) == "text":
        _fields(fmt, "type")
        return
    if "grammar" in fmt:
        _fields(fmt, "type grammar")
        fmt = _fields(fmt["grammar"], "syntax definition")
    for name in ("syntax", "definition"):
        if name in fmt:
            _string(fmt[name])


def _responses_namespace(value: object) -> None:
    namespace = _fields(value, "type name description tools")
    _kind(namespace, {"namespace": "namespace"})

    def check_tool(value: object) -> None:
        tool = _fields(value, "type name description format parameters strict")
        kind = _kind(tool, {"custom": "custom", "function": "function"})
        _fields(tool, "type name description format" if kind == "custom" else
                "type name description parameters strict")
        if kind == "custom" and "format" in tool:
            _custom_format(tool["format"])

    _items(namespace.get("tools"), check_tool)


def _completion_part(value: object, web: bool) -> None:
    part = _fields(value, "type text image_url video_url audio_url input_audio file")
    kind = _kind(part, {key: key for key in ("text", "image_url", "video_url", "audio_url", "input_audio", "file")})
    _fields(part, {"text": "type text", "image_url": "type image_url", "video_url": "type video_url",
                   "audio_url": "type audio_url", "input_audio": "type input_audio", "file": "type file"}[kind])
    if kind in {"image_url", "video_url", "audio_url"}:
        media = part.get(kind)
        if isinstance(media, dict):
            media = _fields(media, "url detail")
            media = media.get("url")
        _url(media, web)
    elif kind == "input_audio":
        audio = _fields(part.get("input_audio"), "data format")
        if not isinstance(audio.get("format"), str):
            raise ValueError("invalid inline audio")
        _inline_base64(audio.get("data"))
    elif kind == "file":
        file = _fields(part.get("file"), "file_id filename file_data file_url")
        if "file_id" in file:
            _file_id(file["file_id"])
        if "file_url" in file:
            _url(file["file_url"], web)
        if "file_data" in file and not _content_url_allowed(file["file_data"], False):
            raise ValueError("invalid inline file")


def _validate_request_structure(payload: dict[str, object], protocol: str, web: bool) -> str | None:
    """Allow known provider forms at every provider-interpreted nesting level."""
    try:
        if protocol == "anthropic-messages":
            if "messages" in payload:
                _items(payload["messages"], lambda m: _anthropic_message(m, web))
            if "system" in payload and not isinstance(payload["system"], str):
                _items(payload["system"], lambda b: _anthropic_block(b, web))
            if "tools" in payload:
                for tool in payload["tools"]:
                    kind = tool.get("type")
                    _fields(tool, "type name description input_schema cache_control defer_loading max_uses allowed_callers")
                    if kind is not None and not ANTHROPIC_WEB_TOOL.fullmatch(kind):
                        raise ValueError("unknown tool")
                    if "cache_control" in tool:
                        _fields(tool["cache_control"], "type ttl scope")
                    if "allowed_callers" in tool:
                        _items(tool["allowed_callers"], _string)
            if "metadata" in payload:
                _fields(payload["metadata"], "user_id")
        elif protocol == "openai-responses":
            if "input" in payload and not isinstance(payload["input"], str):
                _items(payload["input"], lambda item: _responses_item(item, web))
            if "instructions" in payload and not isinstance(payload["instructions"], str):
                raise ValueError("instructions must be text")
            if "prompt_cache_key" in payload:
                _string(payload["prompt_cache_key"])
            if "client_metadata" in payload:
                metadata = _fields(payload["client_metadata"],
                                   "root_turn_id session_id thread_id turn_id x-codex-installation-id "
                                   "x-codex-turn-metadata x-codex-window-id")
                for value in metadata.values():
                    _string(value)
            if "tools" in payload:
                for tool in payload["tools"]:
                    kind = tool["type"]
                    forms = {"function": "type name description parameters strict", "custom": "type name description format",
                             "local_shell": "type", "web_search": "type search_context_size user_location",
                             "web_search_preview": "type search_context_size user_location"}
                    _fields(tool, forms[kind])
                    if kind == "custom" and "format" in tool:
                        _custom_format(tool["format"])
                    if kind in OPENAI_WEB_TOOLS and "user_location" in tool:
                        _fields(tool["user_location"], "type city region country timezone")
            if "include" in payload:
                _items(payload["include"], lambda name: _string(name))
        else:
            if "messages" in payload:
                _items(payload["messages"], lambda m: _completion_message(m, web))
            if "tools" in payload:
                for tool in payload["tools"]:
                    _fields(tool, "type function")
                    _fields(tool.get("function"), "name description parameters strict")
            if "stop" in payload:
                stops = payload["stop"]
                if not isinstance(stops, str):
                    _items(stops, lambda name: _string(name))
        for field, check in _SCALAR_FIELDS.items():
            if field in payload:
                check(payload[field])
        for field, names in (("thinking", "type budget_tokens display"), ("output_config", "effort format"),
                             ("context_management", "edits"), ("reasoning", "effort summary generate_summary context"),
                             ("stream_options", "include_usage"), ("response_format", "type json_schema")):
            if field in payload:
                _fields(payload[field], names)
        if "thinking" in payload:
            thinking = payload["thinking"]
            if (("type" in thinking and not isinstance(thinking["type"], str))
                    or ("display" in thinking and not isinstance(thinking["display"], str))
                    or ("budget_tokens" in thinking and type(thinking["budget_tokens"]) is not int)):
                raise ValueError("invalid thinking structure")
        if "reasoning" in payload and "context" in payload["reasoning"]:
            _string(payload["reasoning"]["context"])
        if "context_management" in payload and "edits" in payload["context_management"]:
            def check_edit(value: object) -> None:
                edit = _fields(value, "type trigger keep tool_names clear_at_least")
                for name in ("trigger", "keep", "clear_at_least"):
                    if name in edit and isinstance(edit[name], dict):
                        _fields(edit[name], "type value tokens")
            _items(payload["context_management"]["edits"], check_edit)
        if protocol == "openai-completions" and isinstance(payload.get("tool_choice"), dict):
            _fields(payload["tool_choice"]["function"], "name")
        if "text" in payload:
            text = _fields(payload["text"], "format verbosity")
            if "format" in text:
                _fields(text["format"], "type name description schema strict")
        if "response_format" in payload and "json_schema" in payload["response_format"]:
            _fields(payload["response_format"]["json_schema"], "name description schema strict")
        if "output_config" in payload and "format" in payload["output_config"]:
            _fields(payload["output_config"]["format"], "type schema")
    except (ValueError, TypeError, KeyError, RecursionError):
        return "content_structure_not_allowed"
    return None


def _anthropic_message(value: object, web: bool) -> None:
    message = _fields(value, "role content")
    content = message.get("content")
    if not isinstance(content, str):
        _items(content, lambda block: _anthropic_block(block, web))


def _string(value: object) -> None:
    if not isinstance(value, str):
        raise ValueError("expected string")


def _boolean(value: object) -> None:
    if type(value) is not bool:
        raise ValueError("expected boolean")


def _integer(value: object) -> None:
    if type(value) is not int:
        raise ValueError("expected integer")


def _number(value: object) -> None:
    if type(value) not in (int, float):
        raise ValueError("expected number")


# Scalar request fields the provider reads as plain values; a wrong type is refused here
# instead of reaching the backend. `store` must be exactly a boolean.
_SCALAR_FIELDS = {
    "stream": _boolean, "store": _boolean, "background": _boolean, "parallel_tool_calls": _boolean,
    "temperature": _number, "top_p": _number,
    "max_tokens": _integer, "max_completion_tokens": _integer, "max_output_tokens": _integer, "seed": _integer,
    "truncation": _string, "service_tier": _string, "previous_response_id": _string,
}


# Pi (0.83/0.87) replays the previous turn's thinking text in the assistant message; Ollama emits it as `reasoning`.
# Plain text only: any other shape (object, list, URL structure) is refused, and only on role assistant.
_REASONING_FIELDS = ("reasoning", "reasoning_content", "reasoning_text")


def _completion_message(value: object, web: bool) -> None:
    message = _fields(value, "role content name tool_call_id tool_calls function_call refusal audio "
                      + " ".join(_REASONING_FIELDS))
    for name in _REASONING_FIELDS:
        if name in message:
            if message.get("role") != "assistant":
                raise ValueError("reasoning only on assistant messages")
            _string(message[name])
    content = message.get("content")
    if content is not None and not isinstance(content, str):
        _items(content, lambda part: _completion_part(part, web))
    if "tool_calls" in message:
        def check_call(value: object) -> None:
            call = _fields(value, "id type function")
            _kind(call, {"function": "function"})
            _fields(call.get("function"), "name arguments")
        _items(message["tool_calls"], check_call)
    if "function_call" in message:
        _fields(message["function_call"], "name arguments")
    if "audio" in message:
        _fields(message["audio"], "id")


@dataclass(frozen=True)
class BackendConfig:
    """Controller-owned fixed upstream configuration."""

    provider: str
    model: str
    protocol: str
    kind: str
    base_url: str
    execution_host: str
    inference_host: str
    auth_headers: tuple[tuple[str, str], ...] = ()
    local_only: bool = False
    # Codex-Sperre (agents_codex_sperre.CodexSperre): prueft jeden Werkzeugaufruf der Antwort, bevor Codex ihn sieht.
    antwort_pruefung: object = field(default=None, compare=False, repr=False)

    def __post_init__(self) -> None:
        if self.antwort_pruefung is not None and (
                self.protocol != "openai-responses" or not callable(getattr(self.antwort_pruefung, "strom", None))
                or not callable(getattr(self.antwort_pruefung, "json_koerper", None))):
            raise ModelProxyError("Response check needs the Responses protocol and a stream rewriter")
        if not isinstance(self.base_url, str):
            raise ModelProxyError("Backend URL must be a string")
        _validate_model_id(self.model)
        if not _ID_PATTERN.fullmatch(self.provider):
            raise ModelProxyError("Invalid backend provider or model")
        if self.protocol not in ROUTES:
            raise ModelProxyError("Unsupported model protocol")
        if self.kind not in {"local", "cloud"}:
            raise ModelProxyError("Backend kind must be local or cloud")
        if not _ID_PATTERN.fullmatch(self.execution_host) or not _ID_PATTERN.fullmatch(self.inference_host):
            raise ModelProxyError("Invalid execution or inference host")
        if self.kind == "local":
            if self.inference_host not in {"mac", "peer"}:
                raise ModelProxyError("Local inference is allowed only on canonical mac or peer hosts")
            if self.execution_host != self.inference_host:
                raise ModelProxyError("Remote local inference needs a separate explicit route")
        elif self.inference_host != "cloud":
            raise ModelProxyError("Cloud backend must declare inference_host=cloud")
        if not isinstance(self.local_only, bool):
            raise ModelProxyError("local_only must be boolean")
        _validate_auth_headers(self.auth_headers)
        _validate_backend_url(self)


def _validate_auth_headers(headers: object) -> tuple[tuple[str, str], ...]:
    # Fehlermeldungen nennen nie einen Headerwert: dort stehen Zugangsdaten.
    if not isinstance(headers, tuple) or any(
        not isinstance(item, tuple) or len(item) != 2 for item in headers
    ):
        raise ModelProxyError("Controller authentication headers must be an immutable tuple")
    seen: set[str] = set()
    for name, value in headers:
        if not isinstance(name, str):
            raise ModelProxyError("Invalid controller authentication header")
        lowered = name.lower()
        if not _HEADER_PATTERN.fullmatch(name) or lowered in seen or lowered in HOP_BY_HOP_HEADERS:
            raise ModelProxyError("Invalid controller authentication header")
        if lowered in {"host", "content-length"} or not isinstance(value, str) or "\r" in value or "\n" in value:
            raise ModelProxyError("Invalid controller authentication header")
        seen.add(lowered)
    return headers


@dataclass(frozen=True)
class _BackendTarget:
    scheme: str
    host: str | None
    port: int | None
    unix_path: Path | None
    path_prefix: str = ""


def _validate_backend_url(config: BackendConfig) -> _BackendTarget:
    parsed = urlsplit(config.base_url)
    if parsed.scheme == "unix":
        if parsed.netloc or parsed.query or parsed.fragment or not parsed.path.startswith("/"):
            raise ModelProxyError("Unix backend URL must contain one absolute socket path")
        if config.kind != "local":
            raise ModelProxyError("Unix backend must be local")
        return _BackendTarget("unix", None, None, Path(parsed.path))
    if parsed.scheme not in {"http", "https"}:
        raise ModelProxyError("Backend URL scheme is not allowed")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ModelProxyError("Backend URL must be an origin without credentials, query, or path")
    if not parsed.hostname:
        raise ModelProxyError("Backend URL has no host")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ModelProxyError("Backend URL has an invalid port") from exc
    local_address = False
    try:
        local_address = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        local_address = False
    path_prefix = ""
    if parsed.path not in {"", "/"}:
        if parsed.scheme != "http" or not local_address or not _FILTER_ROUTE.fullmatch(parsed.path):
            raise ModelProxyError("Backend URL must be an origin without credentials, query, or path")
        path_prefix = parsed.path
    if config.kind == "local" and not local_address:
        raise ModelProxyError("Local backend must use a numeric loopback address or Unix socket")
    if config.local_only and (config.kind != "local" or config.execution_host != config.inference_host or not local_address):
        raise ModelProxyError("local_only refuses cloud, DNS, and remote backends")
    return _BackendTarget(parsed.scheme, parsed.hostname, port, None, path_prefix)


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: Path, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self._unix_path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(self._unix_path))


class _ThreadingUnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = False
    block_on_close = True

    def __init__(self, path: str, owner: "AgentsModelProxy"):
        self.owner = owner
        self.revoked = threading.Event()
        self._active_clients: set[socket.socket] = set()
        self._active_upstreams: set[http.client.HTTPConnection] = set()
        self._active_lock = threading.Lock()
        self._client_slots = threading.BoundedSemaphore(owner.max_connections)
        super().__init__(path, _ProxyHandler)

    def process_request(self, request, client_address):
        if not self._client_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._client_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._client_slots.release()

    def is_current(self) -> bool:
        if self.revoked.is_set():
            return False
        try:
            return self.owner.current_run_checker(self.owner.binding) is True
        except Exception:
            return False

    def register_client(self, client: socket.socket) -> None:
        with self._active_lock:
            self._active_clients.add(client)

    def unregister_client(self, client: socket.socket) -> None:
        with self._active_lock:
            self._active_clients.discard(client)

    def register_upstream(self, upstream: http.client.HTTPConnection) -> None:
        with self._active_lock:
            self._active_upstreams.add(upstream)

    def unregister_upstream(self, upstream: http.client.HTTPConnection) -> None:
        with self._active_lock:
            self._active_upstreams.discard(upstream)

    def close_active(self) -> None:
        with self._active_lock:
            clients = list(self._active_clients)
            upstreams = list(self._active_upstreams)
        for upstream in upstreams:
            try:
                upstream.close()
            except OSError:
                pass
        for client in clients:
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                client.close()
            except OSError:
                pass

    def revoke_after_response(self) -> None:
        if self.revoked.is_set():
            return
        self.revoked.set()
        self.owner._schedule_stop()


class _ProxyHandler(BaseHTTPRequestHandler):
    server: _ThreadingUnixServer
    protocol_version = "HTTP/1.1"
    server_version = "AgentsModelProxy/1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(self.server.owner.io_timeout)
        self.server.register_client(self.connection)

    def finish(self) -> None:
        self.server.unregister_client(self.connection)
        try:
            super().finish()
        except OSError:
            pass

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _send_json_error(self, status_code: int, code: str) -> None:
        body = json.dumps({"error": {"type": code, "message": code}}, separators=(",", ":")).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except OSError:
            pass
        self.close_connection = True

    def _reject_method(self) -> None:
        self._send_json_error(405, "method_not_allowed")

    do_CONNECT = _reject_method
    do_DELETE = _reject_method
    do_GET = _reject_method
    do_HEAD = _reject_method
    do_OPTIONS = _reject_method
    do_PATCH = _reject_method
    do_PUT = _reject_method
    do_TRACE = _reject_method

    def _drain_small_body(self) -> None:
        """Liest einen erlaubten, begrenzten Body vor einer Ablehnung weg.

        Ohne das schliesst der Proxy, waehrend der Client noch sendet, und der Client
        sieht statt der Fehlerantwort einen abgebrochenen Schreibvorgang.
        """
        if self.headers.get("Transfer-Encoding"):
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            return
        if length <= 0 or length > self.server.owner.max_request_bytes:
            return
        deadline = time.monotonic() + min(1.0, self.server.owner.io_timeout)
        remaining_bytes = length
        try:
            while remaining_bytes > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                self.connection.settimeout(remaining)
                chunk = self.rfile.read(min(STREAM_CHUNK_BYTES, remaining_bytes))
                if not chunk:
                    return
                remaining_bytes -= len(chunk)
        except (OSError, ValueError):
            return
        finally:
            try:
                self.connection.settimeout(self.server.owner.io_timeout)
            except OSError:
                pass

    def _read_request_body(self) -> bytes | None:
        if self.headers.get("Transfer-Encoding"):
            self._send_json_error(400, "transfer_encoding_not_allowed")
            return None
        if self.headers.get("Content-Encoding"):
            self._drain_small_body()
            self._send_json_error(400, "content_encoding_not_allowed")
            return None
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else -1
        except ValueError:
            length = -1
        if length < 0:
            self._send_json_error(411, "content_length_required")
            return None
        if length > self.server.owner.max_request_bytes:
            self._send_json_error(413, "request_too_large")
            return None
        body = bytearray()
        deadline = time.monotonic() + self.server.owner.io_timeout
        while len(body) < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._send_json_error(408, "request_timeout")
                return None
            self.connection.settimeout(remaining)
            try:
                chunk = self.rfile.read(min(STREAM_CHUNK_BYTES, length - len(body)))
            except socket.timeout:
                self._send_json_error(408, "request_timeout")
                return None
            except (OSError, ValueError):
                self.close_connection = True
                return None
            if not chunk:
                self._send_json_error(400, "incomplete_request")
                return None
            body.extend(chunk)
        self.connection.settimeout(self.server.owner.io_timeout)
        return bytes(body)

    def do_POST(self) -> None:  # noqa: N802
        if not self.server.is_current():
            self._send_json_error(410, "run_revoked")
            self.server.revoke_after_response()
            return
        expected_path = ROUTES[self.server.owner.backend.protocol]
        if self.path != expected_path:
            self._drain_small_body()
            self._send_json_error(404, "route_not_allowed")
            return
        body = self._read_request_body()
        if body is None:
            return
        try:
            payload = json.loads(body, object_pairs_hook=_unique_object, parse_constant=_reject_json_constant,
                                 parse_float=_finite_json_float)
        except (UnicodeDecodeError, ValueError, RecursionError):
            self._send_json_error(400, "invalid_json")
            return
        if not isinstance(payload, dict) or payload.get("model") != self.server.owner.binding.model:
            self._send_json_error(409, "model_binding_mismatch")
            return
        protocol = self.server.owner.backend.protocol
        if set(payload) - REQUEST_FIELDS[protocol]:
            self._send_json_error(400, "request_field_not_allowed")
            return
        tool_error = _validate_tools(payload, protocol, self.server.owner.binding.web)
        if tool_error:
            self._send_json_error(400, tool_error)
            return
        choice_error = _validate_tool_choice(payload, protocol, self.server.owner.binding.web)
        if choice_error:
            self._send_json_error(400, choice_error)
            return
        source_error = _validate_request_structure(payload, protocol, self.server.owner.binding.web)
        if source_error:
            self._send_json_error(400, source_error)
            return
        try:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        except (UnicodeEncodeError, ValueError, RecursionError):
            self._send_json_error(400, "invalid_json")
            return
        if len(body) > self.server.owner.max_request_bytes:
            self._send_json_error(413, "request_too_large")
            return
        if not self.server.is_current():
            self._send_json_error(410, "run_revoked")
            self.server.revoke_after_response()
            return
        if self.server.owner.backend.provider == "codex":
            target = _validate_backend_url(self.server.owner.backend)
            upstream_path = CODEX_FILTER_UPSTREAM_PATH if target.path_prefix else CODEX_UPSTREAM_PATH
        else:
            upstream_path = expected_path
        self._forward(body, upstream_path, payload)

    def _forward(self, body: bytes, path: str, payload: dict[str, object] | None = None) -> None:
        owner = self.server.owner
        try:
            auth_headers = owner._current_auth_headers()
        except Exception:
            owner._count("controller_auth_unavailable")
            self._send_json_error(503, "controller_auth_unavailable")
            return
        if payload is not None:
            owner._note_request(payload)
        upstream = owner._new_upstream()
        self.server.register_upstream(upstream)
        headers: dict[str, str] = {}
        for name, value in self.headers.items():
            lowered = name.lower()
            if lowered == "anthropic-beta" and (owner.backend.protocol != "anthropic-messages"
                                                or value not in ANTHROPIC_BETA_VALUES):
                continue
            if lowered in FORWARDED_REQUEST_HEADERS and lowered != "content-type":
                headers[name] = value
        headers["Content-Type"] = "application/json"
        for name, value in auth_headers:
            headers[name] = value
        if owner.backend.provider == "codex":
            headers["OpenAI-Beta"] = "responses=experimental"
            headers["originator"] = "codex_cli_rs"
        headers["Content-Length"] = str(len(body))
        response_started = False
        try:
            upstream.request("POST", _validate_backend_url(owner.backend).path_prefix + path, body=body,
                             headers=headers)
            response = upstream.getresponse()
            owner._count(str(response.status))
            if 300 <= response.status < 400:
                response.close()
                self._send_json_error(502, "backend_redirect_refused")
                return
            if response.status in LIMIT_STATUSES:
                owner._record_limit(response.status, response.getheaders())
            pruefung = owner.backend.antwort_pruefung
            if pruefung is not None:
                self._forward_checked(response, pruefung)
                return
            self.send_response(response.status)
            for name, value in response.getheaders():
                if _forward_response_header(name, value):
                    self.send_header(name, value)
            self.send_header("Connection", "close")
            self.end_headers()
            response_started = True
            while True:
                if not self.server.is_current():
                    self.server.revoke_after_response()
                    return
                chunk = response.read1(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                if not self.server.is_current():
                    self.server.revoke_after_response()
                    return
                self.wfile.write(chunk)
                self.wfile.flush()
            self.close_connection = True
        except (TimeoutError, socket.timeout, ConnectionError, OSError, http.client.HTTPException, ssl.SSLError):
            owner._count("transport_error")
            if not response_started and not self.wfile.closed:
                try:
                    self._send_json_error(502, "backend_transport_error")
                except (BrokenPipeError, OSError):
                    pass
            self.close_connection = True
        finally:
            upstream.close()
            self.server.unregister_upstream(upstream)


    def _forward_checked(self, response: http.client.HTTPResponse, pruefung: object) -> None:
        """Codex-Sperre: jede Antwort geht ereignisweise durch die Pruefung; ohne Laenge, Ende am Verbindungsende.

        Ein Fehler der Pruefung bricht den Strom ab, bevor ungepruefte Bytes weitergehen."""
        owner = self.server.owner
        streaming = (response.getheader("content-type") or "").split(";", 1)[0].strip().lower() == "text/event-stream"
        body = b""
        if not streaming:
            while len(body) <= self.server.owner.max_request_bytes:
                chunk = response.read1(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                body += chunk
            if len(body) > self.server.owner.max_request_bytes:
                owner._count("codex_sperre_abbruch")
                self._send_json_error(502, "response_too_large")
                self.close_connection = True
                return
            try:
                body = pruefung.json_koerper(body)  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001 - ungepruefte Antwort geht nie weiter
                owner._count("codex_sperre_abbruch")
                self._send_json_error(502, "response_check_failed")
                self.close_connection = True
                return
        self.send_response(response.status)
        for name, value in response.getheaders():
            if _forward_response_header(name, value) and name.lower() != "content-length":
                self.send_header(name, value)
        if not streaming:
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if not streaming:
            self.wfile.write(body)
            self.wfile.flush()
            return
        strom = pruefung.strom()  # type: ignore[attr-defined]
        while True:
            if not self.server.is_current():
                self.server.revoke_after_response()
                return
            chunk = response.read1(STREAM_CHUNK_BYTES)
            try:
                out = strom.feed(chunk) if chunk else strom.ende()
            except Exception:  # noqa: BLE001 - Abbruch statt ungepruefter Weitergabe
                owner._count("codex_sperre_abbruch")
                return
            if not self.server.is_current():
                self.server.revoke_after_response()
                return
            if out:
                self.wfile.write(out)
                self.wfile.flush()
            if not chunk:
                break


class AgentsModelProxy:
    """One controller-owned model endpoint for one immutable agent run."""

    def __init__(
        self,
        binding: ProxyBinding,
        backend: BackendConfig,
        socket_path: Path,
        controller_root: Path,
        agent_write_roots: Iterable[Path],
        current_run_checker: Callable[[ProxyBinding], bool],
        *,
        socket_mode: int = 0o660,
        socket_group_gid: int | None = None,
        max_request_bytes: int = MAX_REQUEST_BYTES,
        io_timeout: float = DEFAULT_IO_TIMEOUT,
        max_connections: int = 8,
        auth_headers_provider: Callable[[], tuple[tuple[str, str], ...]] | None = None,
    ):
        if binding.provider != backend.provider or binding.model != backend.model:
            raise ModelProxyError("Backend does not match immutable provider/model binding")
        if not callable(current_run_checker):
            raise ModelProxyError("current-run checker is required")
        if auth_headers_provider is not None and not callable(auth_headers_provider):
            raise ModelProxyError("Authentication provider must be callable")
        if auth_headers_provider is not None and backend.auth_headers:
            raise ModelProxyError("Use either fixed or provided controller authentication")
        if type(max_connections) is not int or max_connections <= 0:
            raise ModelProxyError("Connection limit must be a positive integer")
        if socket_mode & 0o007 or socket_mode & ~0o777:
            raise ModelProxyError("Socket mode must not grant world access")
        if (type(max_request_bytes) is not int or max_request_bytes <= 0
                or type(io_timeout) not in (int, float)
                or not math.isfinite(io_timeout) or io_timeout <= 0):
            raise ModelProxyError("Request limit and I/O timeout must be positive")
        self.binding = binding
        self.backend = backend
        self.current_run_checker = current_run_checker
        self.socket_path = Path(socket_path)
        self.controller_root = Path(controller_root)
        self.agent_write_roots = tuple(Path(path) for path in agent_write_roots)
        self.socket_mode = socket_mode
        self.socket_group_gid = socket_group_gid
        self.max_request_bytes = max_request_bytes
        self.io_timeout = io_timeout
        self.max_connections = max_connections
        self._server: _ThreadingUnixServer | None = None
        self._thread: threading.Thread | None = None
        self._socket_inode: int | None = None
        self.auth_headers_provider = auth_headers_provider
        self._state_lock = threading.Lock()
        self._closed = False
        self._counts: dict[str, int] = {}
        self._counts_lock = threading.Lock()
        self._last_limit: dict[str, object] | None = None
        self._request_shapes: dict[str, int] = {}
        self._tool_types: dict[str, int] = {}
        if socket_group_gid is not None and (not isinstance(socket_group_gid, int) or socket_group_gid < 0):
            raise ModelProxyError("Socket group id must be a non-negative integer")

    def _current_auth_headers(self) -> tuple[tuple[str, str], ...]:
        # Die Quelle wird je Anfrage gelesen, damit eine erneuerte Anmeldung ohne
        # Neustart wirkt. Ein Fehler der Quelle leitet nichts weiter.
        if self.auth_headers_provider is None:
            return self.backend.auth_headers
        return _validate_auth_headers(self.auth_headers_provider())

    def _count(self, key: str) -> None:
        with self._counts_lock:
            self._counts[key] = self._counts.get(key, 0) + 1

    def _note_request(self, payload: dict[str, object]) -> None:
        # Nur Form, kein Inhalt: welche Denkstufe und welche Thinking-Art die Anfrage traegt.
        config = payload.get("output_config")
        effort = config.get("effort") if isinstance(config, dict) else None
        thinking = payload.get("thinking")
        kind = thinking.get("type") if isinstance(thinking, dict) else None
        key = "effort=%s thinking=%s" % (effort if effort in _EFFORT_VALUES else "-",
                                         kind if kind in _THINKING_TYPES else "-")
        with self._counts_lock:
            self._request_shapes[key] = self._request_shapes.get(key, 0) + 1
            for tool in payload.get("tools") or []:
                kind = tool.get("type") or "client:untyped"
                self._tool_types[kind] = self._tool_types.get(kind, 0) + 1

    def request_shapes(self) -> dict[str, int]:
        """Weitergeleitete Anfragen je Denkstufe und Thinking-Art, ohne Inhalte."""
        with self._counts_lock:
            return dict(self._request_shapes)

    def request_tool_types(self) -> dict[str, int]:
        """Accepted tool declaration types only; never names, schemas or inputs."""
        with self._counts_lock:
            return dict(self._tool_types)

    def upstream_counts(self) -> dict[str, int]:
        """Upstream-Statusklassen je Anzahl, ohne Inhalte oder Headerwerte."""
        with self._counts_lock:
            return dict(self._counts)

    def _record_limit(self, status: int, headers: Iterable[tuple[str, str]]) -> None:
        values = {name.lower(): value for name, value in headers
                  if (name.lower() == "retry-after" or name.lower().startswith(LIMIT_HEADER_PREFIX)
                      or name.lower() in CODEX_RESET_HEADERS)
                  and _LIMIT_VALUE.fullmatch(value)}
        with self._counts_lock:
            self._last_limit = {"status": status, "at": time.time(), "headers": values}

    def upstream_limit(self) -> dict[str, object] | None:
        """Letzte Kontingent- oder Anmeldeabweisung des Backends: Status, Zeit, Limit-Header."""
        with self._counts_lock:
            return None if self._last_limit is None else dict(self._last_limit, headers=dict(self._last_limit["headers"]))

    def _validate_socket_location(self) -> None:
        if not self.socket_path.is_absolute() or not self.controller_root.is_absolute():
            raise ModelProxyError("Controller root and socket path must be absolute")
        for configured in (self.controller_root, self.socket_path.parent):
            if '..' in configured.parts:
                raise ModelProxyError("Controller paths must be canonical")
            for component in (configured, *configured.parents):
                try:
                    info = component.lstat()
                except OSError as exc:
                    raise ModelProxyError("Controller path ancestor is unavailable") from exc
                sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
                if (not stat.S_ISDIR(info.st_mode)
                        or info.st_uid not in {0, os.geteuid()}
                        or (info.st_mode & 0o022 and not sticky_root)):
                    raise ModelProxyError("Controller path ancestor is not trusted")
        if self.controller_root.is_symlink() or self.socket_path.parent.is_symlink():
            raise ModelProxyError("Controller socket path must not traverse configured symlinks")
        try:
            root = self.controller_root.resolve(strict=True)
            parent = self.socket_path.parent.resolve(strict=True)
        except OSError as exc:
            raise ModelProxyError("Controller socket parent does not exist") from exc
        if not root.is_dir() or not parent.is_dir() or not _is_within(parent, root):
            raise ModelProxyError("Socket must be inside the private controller root")
        if root.stat().st_uid != os.geteuid() or stat.S_IMODE(root.stat().st_mode) & 0o077:
            raise ModelProxyError("Controller root must be private")
        for component in (root, parent):
            if component.is_symlink() or stat.S_IMODE(component.stat().st_mode) & 0o022:
                raise ModelProxyError("Controller socket directory is not trusted")
        socket_candidate = parent / self.socket_path.name
        for write_root in self.agent_write_roots:
            try:
                resolved_write_root = write_root.resolve(strict=True)
            except OSError as exc:
                raise ModelProxyError("Agent write root does not exist") from exc
            if _is_within(socket_candidate, resolved_write_root):
                raise ModelProxyError("Controller socket is inside an agent-writable root")
        if self.socket_path.exists() or self.socket_path.is_symlink():
            raise ModelProxyError("Controller socket path already exists")

    def start(self) -> Path:
        with self._state_lock:
            if self._server is not None or self._closed:
                raise ModelProxyError("Model proxy cannot be started again")
            self._validate_socket_location()
            try:
                server = _ThreadingUnixServer(str(self.socket_path), self)
                self._socket_inode = self.socket_path.lstat().st_ino
                os.chmod(self.socket_path, self.socket_mode)
                if self.socket_group_gid is not None:
                    os.chown(self.socket_path, -1, self.socket_group_gid)
                thread = threading.Thread(target=server.serve_forever, name="agents-model-proxy", daemon=False)
                self._server = server
                self._thread = thread
                thread.start()
            except Exception:
                try:
                    server.server_close()  # type: ignore[possibly-undefined]
                except (OSError, UnboundLocalError):
                    pass
                self._unlink_owned_socket()
                raise
        return self.socket_path

    def _new_upstream(self) -> http.client.HTTPConnection:
        target = _validate_backend_url(self.backend)
        if target.scheme == "unix":
            assert target.unix_path is not None
            return _UnixHTTPConnection(target.unix_path, self.io_timeout)
        if target.scheme == "https":
            return http.client.HTTPSConnection(target.host, target.port, timeout=self.io_timeout)
        return http.client.HTTPConnection(target.host, target.port, timeout=self.io_timeout)

    def _schedule_stop(self) -> None:
        threading.Thread(target=self.stop, name="agents-model-proxy-revoke", daemon=True).start()

    def _unlink_owned_socket(self) -> None:
        try:
            current = self.socket_path.lstat()
        except FileNotFoundError:
            return
        if self._socket_inode is not None and current.st_ino == self._socket_inode and stat.S_ISSOCK(current.st_mode):
            self.socket_path.unlink()

    def stop(self) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            server = self._server
            thread = self._thread
        if server is not None:
            server.revoked.set()
            server.close_active()
            if thread is not None and thread.is_alive():
                server.shutdown()
            server.server_close()
        self._unlink_owned_socket()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=max(1.0, min(self.io_timeout, 5.0)))

    def join(self, timeout: float | None = None) -> None:
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout)
            if thread.is_alive():
                raise ModelProxyError("Model proxy did not stop before deadline")

    def endpoint(self) -> str:
        """Return the exact controller socket path for typed launcher injection."""

        return str(self.socket_path)

    def __enter__(self) -> "AgentsModelProxy":
        self.start()
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        self.stop()
