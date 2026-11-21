"""A local picture sent inline to a vendor, checked first.

``image_data_uri`` trusts the file's suffix for its type and sends whatever the file holds. For a first-party
adapter that is not enough: the path comes from a job, so a ``.png`` that is really a document, an archive or
a secrets file would be base64-encoded and POSTed to the vendor. This refuses anything whose first bytes are not
a PNG, JPEG or WEBP picture and labels the data URI with the type the BYTES say (``sniff_image_mime``), not the
suffix. Nothing has been sent when it raises, so every refusal is ``not_accepted``.
"""

from __future__ import annotations

import base64
import os
import stat
from pathlib import Path
from typing import Tuple

from modules.capabilities.base import E_BAD_REQUEST, AdapterError, is_url
from modules.capabilities.safe_fetch import sniff_image_mime

PICTURE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


def read_picture(path_str: str, *, max_bytes: int, who: str) -> Tuple[str, bytes]:
    """``(mime, bytes)`` of a LOCAL picture file, only if its suffix is a picture's, it is at most ``max_bytes`` and its first
    bytes are a PNG, JPEG or WEBP picture; the mime is the one the BYTES say. For a vendor that takes the picture as a file
    (an upload), where ``inline_picture`` would take it as a ``data:`` URI. Nothing has been sent when it raises."""
    path = Path(path_str)
    if path.suffix.lower() not in PICTURE_SUFFIXES:
        raise AdapterError(E_BAD_REQUEST, f"{who} takes JPEG, PNG or WEBP pictures", not_accepted=True)
    over = AdapterError(E_BAD_REQUEST, f"the picture is over {max_bytes // (1 << 20)} MB", not_accepted=True)
    fd = None
    try:
        # Open ONCE and decide on that descriptor: O_NONBLOCK so a FIFO named x.png cannot block the open, fstat so a device (a
        # symlink to /dev/zero) or a FIFO is refused before a byte is read, and a read of at most max_bytes + 1 so a file that
        # grew after the size check is still stopped at the cap.
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0))
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise AdapterError(E_BAD_REQUEST, "the picture is not a regular file", not_accepted=True)
        if info.st_size > max_bytes:
            raise over
        with os.fdopen(fd, "rb") as fh:
            fd = None
            data = fh.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise over
    except OSError:
        raise AdapterError(E_BAD_REQUEST, "the picture could not be read", not_accepted=True) from None
    finally:
        if fd is not None:
            os.close(fd)
    mime = sniff_image_mime(data)
    if mime is None:
        raise AdapterError(E_BAD_REQUEST, "the file is not a PNG, JPEG or WEBP picture; it was not sent", not_accepted=True)
    return mime, data


def inline_picture(ref: str, *, max_bytes: int, who: str) -> str:
    """An https link as is; a local file as a ``data:`` URI, only if it is a picture of at most ``max_bytes``."""
    if is_url(ref):
        return ref
    mime, data = read_picture(ref, max_bytes=max_bytes, who=who)
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
