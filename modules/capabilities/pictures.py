"""A local picture sent inline to a vendor, checked first.

``image_data_uri`` trusts the file's suffix for its type and sends whatever the file holds. For a first-party
adapter that is not enough: the path comes from a job, so a ``.png`` that is really a document, an archive or
a secrets file would be base64-encoded and POSTed to the vendor. This refuses anything whose first bytes are not
a PNG, JPEG or WEBP picture and labels the data URI with the type the BYTES say (``sniff_image_mime``), not the
suffix. Nothing has been sent when it raises, so every refusal is ``not_accepted``.
"""

from __future__ import annotations

import base64
from pathlib import Path

from modules.capabilities.base import E_BAD_REQUEST, AdapterError, is_url
from modules.capabilities.safe_fetch import sniff_image_mime

PICTURE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


def inline_picture(ref: str, *, max_bytes: int, who: str) -> str:
    """An https link as is; a local file as a ``data:`` URI, only if it is a picture of at most ``max_bytes``."""
    if is_url(ref):
        return ref
    path = Path(ref)
    if path.suffix.lower() not in PICTURE_SUFFIXES:
        raise AdapterError(E_BAD_REQUEST, f"{who} takes JPEG, PNG or WEBP pictures", not_accepted=True)
    try:
        if path.stat().st_size > max_bytes:
            raise AdapterError(E_BAD_REQUEST, f"the picture is over {max_bytes // (1 << 20)} MB", not_accepted=True)
        data = path.read_bytes()
    except OSError:
        raise AdapterError(E_BAD_REQUEST, "the picture could not be read", not_accepted=True) from None
    mime = sniff_image_mime(data)
    if mime is None:
        raise AdapterError(E_BAD_REQUEST, "the file is not a PNG, JPEG or WEBP picture; it was not sent", not_accepted=True)
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
