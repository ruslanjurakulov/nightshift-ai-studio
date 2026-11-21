"""Tests for modules.structured_output — the roadmap #50 spike helper.

No live Gemini call is made: parse_structured is exercised against tiny
stand-in response objects, and json_config is checked against the installed
google-genai types (skipped only if the SDK types can't be imported).
"""

import unittest

from modules.structured_output import JSON_MIME_TYPE, json_config, parse_structured

try:
    from google.genai import types as _genai_types  # noqa: F401
    _HAS_GENAI = True
except ImportError:  # pragma: no cover - environment without the SDK
    _HAS_GENAI = False


class _Resp:
    """A minimal Gemini-response stand-in with just .parsed and .text."""

    def __init__(self, parsed=None, text=None):
        self.parsed = parsed
        self.text = text


class _Model:
    """A pydantic-like object exposing model_dump(), to prove conversion."""

    def __init__(self, data):
        self._data = data

    def model_dump(self):
        return dict(self._data)


class TestParseStructured(unittest.TestCase):
    def test_prefers_parsed_dict_over_text(self):
        # When the SDK already parsed the schema-constrained JSON, .text is
        # never consulted — even if it holds something else entirely.
        resp = _Resp(parsed={"a": 1}, text="not json at all")
        self.assertEqual(parse_structured(resp), {"a": 1})

    def test_parsed_list_is_returned(self):
        resp = _Resp(parsed=[1, 2, 3], text=None)
        self.assertEqual(parse_structured(resp), [1, 2, 3])

    def test_pydantic_model_is_dumped_to_dict(self):
        resp = _Resp(parsed=_Model({"claim": "x", "confidence": "low"}))
        self.assertEqual(parse_structured(resp), {"claim": "x", "confidence": "low"})

    def test_falls_back_to_plain_text_json(self):
        resp = _Resp(parsed=None, text='{"a": 1}')
        self.assertEqual(parse_structured(resp), {"a": 1})

    def test_falls_back_through_markdown_fences(self):
        resp = _Resp(parsed=None, text='```json\n{"a": 1}\n```')
        self.assertEqual(parse_structured(resp), {"a": 1})

    def test_falls_back_extracting_object_from_prose(self):
        resp = _Resp(parsed=None, text='Sure! Here it is:\n{"a": 1}\nHope that helps.')
        self.assertEqual(parse_structured(resp), {"a": 1})

    def test_extracts_top_level_array(self):
        resp = _Resp(parsed=None, text="Here you go: [1, 2, 3]")
        self.assertEqual(parse_structured(resp), [1, 2, 3])

    def test_empty_response_raises_not_returns_none(self):
        # No parsed object and no usable text is a hard failure, never a silent
        # empty result the caller might mistake for "nothing found".
        with self.assertRaises(ValueError):
            parse_structured(_Resp(parsed=None, text=""))
        with self.assertRaises(ValueError):
            parse_structured(_Resp(parsed=None, text=None))

    def test_unparseable_text_raises(self):
        with self.assertRaises(ValueError):
            parse_structured(_Resp(parsed=None, text="just some words, no json"))

    def test_zero_is_not_treated_as_missing(self):
        # A parsed value that is falsy-but-present (0, [], {}) is still a real
        # answer — null != 0. Only None means "the SDK parsed nothing".
        self.assertEqual(parse_structured(_Resp(parsed=0)), 0)
        self.assertEqual(parse_structured(_Resp(parsed=[])), [])
        self.assertEqual(parse_structured(_Resp(parsed={})), {})


@unittest.skipUnless(_HAS_GENAI, "google-genai types not importable")
class TestJsonConfig(unittest.TestCase):
    def test_sets_json_mime_type(self):
        config = json_config()
        self.assertIsNotNone(config)
        self.assertEqual(config.response_mime_type, JSON_MIME_TYPE)

    def test_carries_schema_and_system_instruction(self):
        schema = {"type": "object", "properties": {"a": {"type": "string"}}}
        config = json_config(schema, system_instruction="be honest")
        self.assertEqual(config.response_mime_type, JSON_MIME_TYPE)
        self.assertIsNotNone(config.response_schema)
        self.assertTrue(config.system_instruction)

    def test_no_schema_leaves_response_schema_unset(self):
        config = json_config()
        self.assertIsNone(getattr(config, "response_schema", None))


if __name__ == "__main__":
    unittest.main()
