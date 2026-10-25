import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { loadingClassName, loadingContent } from "@/components/ui/button-loading";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover active:bg-primary-active",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-danger-hover active:bg-danger-strong",
        outline:
          "border border-input bg-surface text-foreground shadow-xs hover:border-primary/40 hover:bg-surface-hover hover:text-primary active:bg-surface-selected",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary-hover active:bg-secondary-hover",
        ghost:
          "text-foreground hover:bg-surface-hover hover:text-primary active:bg-surface-selected",
        link: "text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary",
      },
      size: {
        default: "h-9 px-4 py-2 pointer-coarse:h-10",
        sm: "h-8 gap-1.5 px-3 text-xs pointer-coarse:h-9 [&_svg]:size-3.5",
        lg: "h-10 px-6 text-[15px]",
        icon: "h-9 w-9 pointer-coarse:h-10 pointer-coarse:w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Async action running: disables the button, swaps its icon for a spinner and shows `loadingText` when given. */
  loading?: boolean;
  /** Label while loading, e.g. "Salvando…"; defaults to the regular label. */
  loadingText?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, loadingText, children, ...props },
    ref,
  ) => {
    if (asChild) {
      return (
        <Slot className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props}>
          {children}
        </Slot>
      );
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }), loading && loadingClassName)}
        ref={ref}
        {...props}
        disabled={props.disabled || loading}
        aria-busy={loading || undefined}
      >
        {loading ? loadingContent(children, size === "icon" ? undefined : loadingText) : children}
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
