"""Human-readable invoice lines."""

from decimal import Decimal

from billing.invoice import Line, line_total


def format_money(amount: Decimal) -> str:
    return f"${amount:,.2f}"


def describe(line: Line) -> str:
    return f"{line.quantity} x {line.description}: {format_money(line_total(line))}"
