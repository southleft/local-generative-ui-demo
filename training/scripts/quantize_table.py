"""Quantize one exported embedding-table tflite (embedder or per_layer_embedder) on its own.

litert-torch applies a single recipe to every file it exports, and the tensors inside are all
named `arith.constant`, so the two tables cannot be told apart by regex. Export with
--keep_temporary_files, then quantize each float table with the bits it can afford:
    <litert-torch python> training/scripts/quantize_table.py float.tflite out.tflite --bits 2
"""
import argparse

from ai_edge_quantizer import qtyping, quantizer, recipe_manager


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("src")
    parser.add_argument("dst")
    parser.add_argument("--bits", type=int, default=4)
    args = parser.parse_args()
    rm = recipe_manager.RecipeManager()
    rm.add_dynamic_config(regex=".*", operation_name=qtyping.TFLOperationName.EMBEDDING_LOOKUP, num_bits=args.bits)
    qt = quantizer.Quantizer(args.src)
    qt.load_quantization_recipe(rm.get_quantization_recipe())
    qt.quantize().export_model(args.dst, overwrite=True)
    print(f"wrote {args.dst} ({args.bits}-bit embedding lookup)")


if __name__ == "__main__":
    main()
