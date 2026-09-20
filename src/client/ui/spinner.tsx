import { IconLoadingOutline16 } from "@deepseek-ai/dsh-client-ui-primitives"
import { cn } from "./utils"

/**
 * Vendored shadcn `Spinner` with the icon swapped to the host's primitive set
 * (the plugin never ships lucide). The host icons render their own `<svg>`, so
 * the props land on a wrapping span instead of the svg element.
 */
function Spinner({ className, ...props }: React.ComponentProps<"span">) {
 return (
 <span role="status" aria-label="Loading" className={cn("inline-flex", className)} {...props}>
 <IconLoadingOutline16 className="size-4 animate-spin" />
 </span>
 )
}

export { Spinner }
