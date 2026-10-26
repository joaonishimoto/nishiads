"use client";

import * as React from "react";
import { format, isValid, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CalendarDays, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type DatePickerProps = {
  value?: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  min?: string;
  max?: string;
  className?: string;
  id?: string;
  "aria-label"?: string;
};

function parseDate(value?: string | null) {
  if (!value) return undefined;
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : undefined;
}

function toIsoDate(date: Date) {
  return format(date, "yyyy-MM-dd");
}

const DatePicker = React.forwardRef<HTMLButtonElement, DatePickerProps>(
  (
    {
      value,
      onChange,
      placeholder,
      disabled,
      required,
      min,
      max,
      className,
      id,
      "aria-label": ariaLabel,
    },
    ref,
  ) => {
    const [open, setOpen] = React.useState(false);
    const selected = parseDate(value);
    const minDate = parseDate(min);
    const maxDate = parseDate(max);
    const dateLocale = ptBR;
    const display = selected ? format(selected, "dd MMM yyyy", { locale: dateLocale }) : null;
    const blocked =
      minDate && maxDate
        ? { before: minDate, after: maxDate }
        : minDate
          ? { before: minDate }
          : maxDate
            ? { after: maxDate }
            : undefined;

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <div className={cn("relative min-w-0", className)}>
          <PopoverTrigger asChild>
            <Button
              ref={ref}
              id={id}
              type="button"
              variant="outline"
              disabled={disabled}
              aria-label={ariaLabel}
              aria-required={required}
              aria-expanded={open}
              className={cn(
                "w-full min-w-0 justify-start overflow-hidden px-3 text-left font-normal shadow-sm",
                !display && "text-muted-foreground",
                value && !disabled && "pr-9",
              )}
            >
              <CalendarDays className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {display ?? placeholder ?? "Selecione uma data"}
              </span>
            </Button>
          </PopoverTrigger>
          {value && !disabled && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-7 w-7 text-muted-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onChange("");
              }}
              aria-label={"Limpar data"}
            >
              <X />
            </Button>
          )}
        </div>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected ?? minDate ?? new Date()}
            onSelect={(date) => {
              if (!date) return;
              onChange(toIsoDate(date));
              setOpen(false);
            }}
            disabled={blocked}
            locale={dateLocale}
            captionLayout="dropdown"
            startMonth={minDate ?? new Date(new Date().getFullYear() - 10, 0)}
            endMonth={maxDate ?? new Date(new Date().getFullYear() + 10, 11)}
            className="pointer-events-auto bg-popover"
          />
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">{"Escolha dia, mês e ano"}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const today = new Date();
                const beforeMin = minDate && today < minDate;
                const afterMax = maxDate && today > maxDate;
                if (beforeMin || afterMax) return;
                onChange(toIsoDate(today));
                setOpen(false);
              }}
            >
              {"Hoje"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  },
);

DatePicker.displayName = "DatePicker";

export { DatePicker, parseDate, toIsoDate };
