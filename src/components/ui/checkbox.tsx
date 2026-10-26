import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

const boxClass =
  "grid h-4 w-4 shrink-0 place-content-center rounded-sm border bg-surface transition-[color,background-color,border-color,box-shadow,transform] duration-200";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      boxClass,
      "cursor-pointer border-input hover:border-primary active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-input disabled:active:scale-100 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="grid place-content-center text-current">
      {props.checked === "indeterminate" ? (
        <Minus className="h-3 w-3" strokeWidth={3.5} />
      ) : (
        <Check className="h-3 w-3 animate-check-in motion-reduce:animate-none" strokeWidth={3.5} />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

/** Presentational mark for rows that are themselves the toggle control. */
const CheckboxMark = ({ checked, className }: { checked: boolean; className?: string }) => (
  <span
    aria-hidden="true"
    className={cn(
      boxClass,
      "group-active:scale-90 group-focus-visible:ring-2 group-focus-visible:ring-ring",
      checked
        ? "border-primary bg-primary text-primary-foreground"
        : "border-input group-hover:border-primary",
      className,
    )}
  >
    {checked ? (
      <Check className="h-3 w-3 animate-check-in motion-reduce:animate-none" strokeWidth={3.5} />
    ) : null}
  </span>
);

export { Checkbox, CheckboxMark };
