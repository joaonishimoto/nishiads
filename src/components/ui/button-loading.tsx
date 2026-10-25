import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

/** Spinner + busy label shared by every action that waits on the server (also used by AlertDialogAction). */
export function loadingContent(children: ReactNode, loadingText?: ReactNode) {
  return (
    <>
      <Loader2 className="animate-spin" aria-hidden="true" />
      {loadingText ?? children}
    </>
  );
}

// While loading, the original icons give way to the spinner and the button stays readable instead of fading out.
export const loadingClassName =
  "disabled:opacity-80 disabled:cursor-progress [&>svg:not(.animate-spin)]:hidden";
