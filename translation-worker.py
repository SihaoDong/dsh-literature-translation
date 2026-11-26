import json
import re
import sys
from pathlib import Path

from ctranslate2 import Translator
from sentencepiece import SentencePieceProcessor

ROOT = Path(__file__).resolve().parent / "model"
TOKEN_LIMIT = 140
tokenizer = SentencePieceProcessor(model_proto=(ROOT / "sentencepiece.model").read_bytes())
translator = Translator("model/model", device="cpu", compute_type="int8", intra_threads=4)


# Keep numeric rows and explicitly delimited display equations out of the model.
NUMBER = r"[+\-\u2212]?\d+(?:[.,]\d+)*%?"
DISPLAY_MATH = (
    r"\$\$[^\r\n]+\$\$|\\\[[^\r\n]+\\\]"
    r"|\$\$[ \t]*\r?\n[\s\S]*?^[ \t]*\$\$"
    r"|\\\[[ \t]*\r?\n[\s\S]*?^[ \t]*\\\]"
)
VERBATIM_LINE = re.compile(
    rf"^([ \t]*(?:{NUMBER}(?:[ \t]+{NUMBER})*|{DISPLAY_MATH})[ \t]*(?=\r?$))",
    re.MULTILINE,
)


def translate(text):
    pieces = VERBATIM_LINE.split(text)
    if len(pieces) == 1:
        return translate_prose(text)
    for index in range(0, len(pieces), 2):
        prose = pieces[index]
        if prose.strip():
            start = len(prose) - len(prose.lstrip())
            end = len(prose.rstrip())
            pieces[index] = prose[:start] + translate_prose(prose[start:end]) + prose[end:]
    return "".join(pieces)


def translate_prose(text):
    paragraphs = re.split(r"\n\s*\n", text.strip())
    batches = []
    for paragraph in paragraphs:
        sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", paragraph.strip())
        pieces = [tokenizer.encode(sentence, out_type=str) for sentence in sentences if sentence.strip()]
        batches.append([piece[i:i + TOKEN_LIMIT] for piece in pieces for i in range(0, len(piece), TOKEN_LIMIT)])
    flat = [piece for paragraph in batches for piece in paragraph]
    results = iter(translator.translate_batch(
        flat, beam_size=2, replace_unknowns=True, max_batch_size=1024, batch_type="tokens",
        max_input_length=TOKEN_LIMIT, max_decoding_length=280, length_penalty=0.2,
    ))
    translated_paragraphs = []
    for paragraph in batches:
        fragments = (
            tokenizer.decode(next(results).hypotheses[0]).replace("▁", " ").strip()
            for _ in paragraph
        )
        translated_paragraphs.append(join_fragments(fragments))
    return "\n\n".join(translated_paragraphs)


def join_fragments(fragments):
    parts = []
    for fragment in fragments:
        if not fragment:
            continue
        if parts and re.fullmatch(r"[A-Za-z0-9]", parts[-1][-1]) and re.match(r"[A-Za-z0-9]", fragment):
            parts.append(" ")
        parts.append(fragment)
    return "".join(parts)


for line in sys.stdin:
    request = json.loads(line)
    try:
        answer = {"id": request["id"], "result": translate(request["text"])}
    except Exception:
        answer = {"id": request["id"], "error": "本地翻译引擎未能生成译文。"}
    print(json.dumps(answer, ensure_ascii=False), flush=True)
