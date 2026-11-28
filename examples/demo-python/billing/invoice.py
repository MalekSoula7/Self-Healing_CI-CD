"""Invoice totals."""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")


@dataclass(frozen=True)
class Line:
    description: str
    unit_price: Decimal
    quantity: int


def line_total(line: Line) -> Decimal:
    return line.unit_price * line.quantity


def invoice_total(lines: list[Line], tax_rate: Decimal) -> Decimal:
    """Subtotal plus tax, rounded half up to the cent."""
    if tax_rate < 0:
        raise ValueError(f"tax_rate must not be negative, got {tax_rate}")
    subtotal = sum((line_total(line) for line in lines), Decimal("0"))
    return (subtotal * (1 + tax_rate)).quantize(CENT, rounding=ROUND_HALF_UP)
