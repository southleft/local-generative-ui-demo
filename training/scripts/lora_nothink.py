#!/usr/bin/env python3
"""mlx_lm.lora with the chat template's thinking channel switched off.

mlx-lm's TokenizerWrapper passes enable_thinking=True whenever the model has a
thinking mode, which for Gemma 4 inserts a <|think|> marker into the system turn
of every training example. The app never asks the model to think and the eval
renders with enable_thinking=False, so training must render the same way.
Everything else is stock mlx_lm.lora; pass the usual arguments.
"""
import sys

from mlx_lm import tokenizer_utils

_original = tokenizer_utils.TokenizerWrapper.apply_chat_template


def _no_thinking(self, *args, **kwargs):
    kwargs.setdefault("enable_thinking", False)
    return _original(self, *args, **kwargs)


tokenizer_utils.TokenizerWrapper.apply_chat_template = _no_thinking

from mlx_lm import lora  # noqa: E402  (patched before the tuner builds its datasets)

sys.argv = ["mlx_lm.lora", *sys.argv[1:]]
lora.main()
