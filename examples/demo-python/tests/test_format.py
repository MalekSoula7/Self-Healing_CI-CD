from decimal import Decimal

from billing.format import describe, format_money
from billing.invoice import Line


def test_format_money_groups_thousands() -> None:
    assert format_money(Decimal("1234567.5")) == "$1,234,567.50"


def test_describe_shows_quantity_and_total() -> None:
    assert describe(Line("Pen", Decimal("1.25"), 2)) == "2 x Pen: $2.50"
