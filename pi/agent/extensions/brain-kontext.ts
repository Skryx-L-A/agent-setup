import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

const BRAIN = `${process.env.HOME}/Knowledge/_meta/tools/braincli/.venv/bin/brain`;

function brain(args: string[], input = ""): string {
  try {
    return execFileSync(BRAIN, ["kontext", ...args, "--harness", "pi"], {
      input,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

export default function brainKontext(pi: ExtensionAPI) {
  let start = "";
  pi.on("session_start", () => {
    start = brain(["start", "--cwd", process.cwd(), "--kein-stdin"]);
  });
  pi.on("before_agent_start", (event) => {
    if (start) event.systemPromptOptions.sections.brain_kontext = start;
    const recall = brain(["prompt", "--cwd", process.cwd()], event.prompt);
    if (recall) {
      return {
        message: {
          customType: "brain-recall",
          content: recall,
          display: false,
        },
      };
    }
  });
}
