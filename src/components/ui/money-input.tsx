import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Cleans typing: digits and separators only, no runaway length. */
function sanitize(raw: string): string {
  return raw.replace(/[^\d.,]/g, "").slice(0, 15);
}

/** Groups thousands with dots: 1234567 -> 1.234.567. */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

function trimLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, "") || "0";
}

/**
 * Live mask applied on every keystroke: thousands grouping and decimals as
 * typed (comma or a short dot as decimal separator). Empty input stays empty.
 */
export function maskTyping(raw: string): string {
  const cleaned = sanitize(raw);
  const commaIndex = cleaned.indexOf(",");
  if (commaIndex !== -1) {
    const intPart = group(trimLeadingZeros(digitsOf(cleaned.slice(0, commaIndex))));
    const decPart = digitsOf(cleaned.slice(commaIndex + 1)).slice(0, 2);
    if (decPart.length === 0 && cleaned.length === commaIndex + 1) return `${intPart},`;
    return `${intPart},${decPart}`;
  }
  const lastDot = cleaned.lastIndexOf(".");
  if (lastDot !== -1) {
    const after = cleaned.slice(lastDot + 1);
    if (/^\d{0,2}$/.test(after)) {
      const intPart = group(trimLeadingZeros(digitsOf(cleaned.slice(0, lastDot))));
      return after.length === 0 ? `${intPart},` : `${intPart},${after}`;
    }
  }
  return group(digitsOf(cleaned).replace(/^0+(?=\d)/, ""));
}

/** Parses masked text to a number. Comma is the decimal separator; dots are grouping. */
export function parseMoney(raw: string): number {
  let text = sanitize(raw);
  if (text.includes(",")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.includes(".")) {
    const parts = text.split(".");
    const last = parts[parts.length - 1] ?? "";
    if (parts.length === 2 && last.length <= 2)
      text = `${(parts[0] ?? "0").replace(/\./g, "")}.${last}`;
    else text = text.replace(/\./g, "");
  }
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Formats with pt-BR grouping (1.234,56); 0 renders as empty so typing starts clean. */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Symbols shown as a fixed prefix inside the field. */
const CURRENCY_SYMBOLS: Record<string, string> = { BRL: "R$", EUR: "€", USD: "US$" };

/** Left padding applied to the input so text starts after the symbol. */
const SYMBOL_PADDING: Record<string, string> = { R$: "pl-10", "€": "pl-8", US$: "pl-11" };

type MoneyInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "inputMode"
> & {
  value: number;
  onChange: (value: number) => void;
  /** Optional currency rendered as a fixed prefix inside the field (R$, €, US$). */
  currency?: string;
};

/**
 * Currency-style input with a live pt-BR mask: thousands separators and
 * decimals appear while typing (no need to blur), the caret stays in place,
 * and the value is always reported as a number to the parent.
 */
/** Cash-register mask: digits fill from the cents. "1234" -> "12,34". */
export function maskCents(raw: string): string {
  const digits = digitsOf(raw).replace(/^0+/, "").slice(0, 13);
  if (!digits) return "";
  const padded = digits.padStart(3, "0");
  return `${group(padded.slice(0, -2))},${padded.slice(-2)}`;
}

export function MoneyInput({ value, onChange, className, currency, ...props }: MoneyInputProps) {
  const [text, setText] = useState(() => formatMoney(value));
  const focused = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input && input.ownerDocument.activeElement === input) {
      input.setSelectionRange(text.length, text.length);
    }
  }, [text]);

  useEffect(() => {
    if (!focused.current) setText(formatMoney(value));
  }, [value]);

  const symbol = currency ? (CURRENCY_SYMBOLS[currency] ?? undefined) : undefined;

  return (
    <div className="relative">
      {symbol ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
        >
          {symbol}
        </span>
      ) : null}
      <Input
        {...props}
        ref={inputRef}
        type="text"
        inputMode="numeric"
        className={cn(symbol ? (SYMBOL_PADDING[symbol] ?? undefined) : undefined, className)}
        value={text}
        placeholder={props.placeholder ?? "0,00"}
        onFocus={(event) => {
          focused.current = true;
          const input = event.currentTarget;
          requestAnimationFrame(() =>
            input.setSelectionRange(input.value.length, input.value.length),
          );
        }}
        onBlur={() => {
          focused.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            const next = maskCents(digitsOf(text).slice(0, -1));
            setText(next);
            onChange(parseMoney(next));
          }
          props.onKeyDown?.(event);
        }}
        onChange={(event) => {
          const next = maskCents(event.currentTarget.value);
          setText(next);
          onChange(parseMoney(next));
        }}
      />
    </div>
  );
}
