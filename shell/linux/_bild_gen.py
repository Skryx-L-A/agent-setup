#!/usr/bin/env python3
# _bild_gen.py — diffusers-CUDA-Treiber hinter dem `bild`-Wrapper (Linux-Port).
# UNGETESTET auf diesem Mac (kein NVIDIA). Verifikation auf Nobara + RTX 4070 SUPER.
#
# 12-GB-Strategie:
#   * FLUX.2 klein 9B/4B: bitsandbytes NF4 (4-bit) fuer Transformer + Text-Encoder,
#     dann enable_model_cpu_offload() (9B) bzw. direkt auf GPU (4B passt).
#   * Qwen-Image: GGUF (Q4_K_S ~12 GB) via GGUFQuantizationConfig, dazu
#     enable_sequential_cpu_offload() — layerweises Offload haelt den Peak klein.
#   * NSFW-LoRA: load_lora_weights() auf die Pipeline (safetensors portabel).
#
# Modellordner sind LOKAL (HF_HUB_OFFLINE=1 setzt der Wrapper). Fuer klein wird die
# diffusers-Pipeline aus dem lokalen Ordner geladen; die NF4-Quantisierung passiert
# beim Laden (bnb). Alternativ kann ein bereits als *-bnb-4bit exportierter Ordner
# stehen — dann greift der Quant-Pfad ohnehin.
import argparse
import sys


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--engine", required=True,
                   choices=["flux2", "flux2-edit", "qwen"])
    p.add_argument("--model", required=True)
    p.add_argument("--gguf", default="")
    p.add_argument("--quant", default="", choices=["", "nf4", "fp8"])
    p.add_argument("--lora", default="")
    p.add_argument("--prompt", required=True)
    p.add_argument("--width", type=int, default=1024)
    p.add_argument("--height", type=int, default=1024)
    p.add_argument("--steps", type=int, default=28)
    p.add_argument("--guidance", type=float, default=None)
    p.add_argument("--offload", default="model",
                   choices=["none", "model", "sequential"])
    p.add_argument("--seed", type=int, nargs="*", default=[])
    p.add_argument("--image", action="append", default=[])
    p.add_argument("--output", required=True)
    return p.parse_args()


def out_path(base, seed, multi):
    if not multi:
        return base
    # mflux-Konvention nachbilden: _seed_<N> vor die Endung haengen.
    if "." in base.rsplit("/", 1)[-1]:
        stem, ext = base.rsplit(".", 1)
        return f"{stem}_seed_{seed}.{ext}"
    return f"{base}_seed_{seed}"


def build_flux2(a, edit):
    import torch
    from diffusers import DiffusionPipeline
    try:
        from diffusers import BitsAndBytesConfig
    except Exception:
        BitsAndBytesConfig = None

    kwargs = dict(torch_dtype=torch.bfloat16)
    if a.quant == "nf4" and BitsAndBytesConfig is not None:
        # 4-bit fuer Transformer + Text-Encoder — der 9B passt so mit Offload in 12 GB.
        bnb = BitsAndBytesConfig(load_in_4bit=True,
                                 bnb_4bit_quant_type="nf4",
                                 bnb_4bit_compute_dtype=torch.bfloat16)
        kwargs["quantization_config"] = bnb
    pipe = DiffusionPipeline.from_pretrained(a.model, **kwargs)
    return pipe


def build_qwen(a):
    import torch
    from diffusers import DiffusionPipeline
    # GGUF-Transformer laden (city96/Qwen-Image-gguf), Rest der Pipeline bf16.
    try:
        from diffusers import GGUFQuantizationConfig
        from diffusers import QwenImageTransformer2DModel
        transformer = QwenImageTransformer2DModel.from_single_file(
            a.gguf,
            quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
            torch_dtype=torch.bfloat16,
        )
        pipe = DiffusionPipeline.from_pretrained(
            a.model, transformer=transformer, torch_dtype=torch.bfloat16)
    except Exception:
        # Fallback: normale bf16-Pipeline (braucht dann sequential-Offload zwingend).
        pipe = DiffusionPipeline.from_pretrained(a.model, torch_dtype=torch.bfloat16)
    return pipe


def main():
    a = parse_args()
    try:
        import torch
    except Exception as e:
        print(f"Fehler: torch/CUDA nicht verfuegbar: {e}", file=sys.stderr)
        sys.exit(1)
    if not torch.cuda.is_available():
        print("Fehler: keine CUDA-GPU sichtbar (nvidia-smi pruefen).", file=sys.stderr)
        sys.exit(1)

    if a.engine in ("flux2", "flux2-edit"):
        pipe = build_flux2(a, edit=(a.engine == "flux2-edit"))
    else:
        pipe = build_qwen(a)

    if a.lora:
        try:
            pipe.load_lora_weights(a.lora)
        except Exception as e:
            print(f"Warnung: LoRA {a.lora} nicht geladen: {e}", file=sys.stderr)

    # Offload-Strategie fuer 12 GB.
    if a.offload == "sequential":
        pipe.enable_sequential_cpu_offload()
    elif a.offload == "model":
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to("cuda")
    try:
        pipe.enable_vae_tiling()
    except Exception:
        pass

    seeds = a.seed if a.seed else [None]
    multi = len(seeds) > 1
    ref_images = None
    if a.image:
        from diffusers.utils import load_image
        ref_images = [load_image(p) for p in a.image]

    for s in seeds:
        gen = None
        if s is not None:
            gen = torch.Generator(device="cuda").manual_seed(int(s))
        call = dict(prompt=a.prompt, width=a.width, height=a.height,
                    num_inference_steps=a.steps, generator=gen)
        if a.guidance is not None:
            call["guidance_scale"] = a.guidance
        if ref_images is not None:
            # FLUX.2 klein nimmt Referenzbilder als `image` (Multi-Ref-Editing).
            call["image"] = ref_images if len(ref_images) > 1 else ref_images[0]
        result = pipe(**call)
        img = result.images[0]
        dst = out_path(a.output, s if s is not None else 0, multi)
        img.save(dst)
        print(dst)


if __name__ == "__main__":
    main()
