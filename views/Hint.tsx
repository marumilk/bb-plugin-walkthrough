// A hover/focus label for a control. bb's Button omits `title` so every hint
// renders as a real tooltip.
import type { ReactElement } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function Hint({
  label,
  children,
}: {
  label: string | undefined;
  children: ReactElement;
}) {
  if (label === undefined) return children;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
