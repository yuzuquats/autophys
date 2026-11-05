"""Explicit offline test inputs shared by numerical replay consumers."""
import pytest

from reasoner_cassette import generate


@pytest.fixture(scope="session")
def current_reasoner_cassette(tmp_path_factory):
    return generate(tmp_path_factory.mktemp("fake-reasoner") / "oscillator.jsonl")
