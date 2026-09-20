import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
 "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
 {
 variants: {
 variant: {
 default: "bg-primary text-primary-foreground hover:bg-primary/90",
 destructive:
 "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 ",
 outline:
 "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground ",
 secondary:
 "bg-secondary text-secondary-foreground hover:bg-secondary/80",
 ghost:
 "hover:bg-accent hover:text-accent-foreground ",
 link: "text-primary underline-offset-4 hover:underline",
 },
 size: {
 default: "h-9 px-4 py-2 has-[>svg]:px-3",
 xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
 sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
 lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
 icon: "size-9",
 "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
 "icon-sm": "size-8",
 "icon-lg": "size-10",
 },
 },
 defaultVariants: {
 variant: "default",
 size: "default",
 },
 }
)

/**
 * LOCAL ADAPTATION: `React.forwardRef`, because this plugin runs on the DSH
 * host's React 18 (ref-as-prop is a React 19 feature). Without it
 * `<TooltipTrigger asChild><Button/></TooltipTrigger>` cannot measure its
 * anchor: radix's `Slot` hands the child a ref and a plain function component
 * drops it (dev builds warn, production silently mis-positions the floating
 * layer). The registry targets React 19 and ships no forwardRef, so a
 * `shadcn add --overwrite` refresh must re-apply this.
 */
const Button = React.forwardRef<
 HTMLButtonElement,
 React.ComponentProps<"button"> &
 VariantProps<typeof buttonVariants> & {
 asChild?: boolean
 }
>(function Button({ className, variant = "default", size = "default", asChild = false, ...props }, ref) {
 const Comp = asChild ? Slot.Root : "button"

 return (
 <Comp
 ref={ref}
 data-slot="button"
 data-variant={variant}
 data-size={size}
 className={cn(buttonVariants({ variant, size, className }))}
 {...props}
 />
 )
})
export { Button, buttonVariants }
