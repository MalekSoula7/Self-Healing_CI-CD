from decimal import Decimal

import pytest

from billing.invoice import Line, invoice_total, line_total

LINES = [Line("Notebook", Decimal("4.50"), 3), Line("Pen", Decimal("1.25"), 2)]


def test_line_total_multiplies_price_by_quantity() -> None:
    assert line_total(LINES[0]) == Decimal("13.50")


def test_invoice_total_adds_tax() -> None:
    assert invoice_total(LINES, Decimal("0.20")) == Decimal("19.20")


def test_invoice_total_rounds_half_up() -> None:
    # 0.125 rounds up to 0.13, not to the even 0.12.
    assert invoice_total([Line("Sticker", Decimal("0.125"), 1)], Decimal("0")) == Decimal("0.13")


def test_invoice_total_rejects_negative_tax() -> None:
    with pytest.raises(ValueError):
        invoice_total(LINES, Decimal("-0.1"))
