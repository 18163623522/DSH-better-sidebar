import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./utils"
import { Slot } from "radix-ui"

const badgeVariants = cva(
 "inline-flex h-[18px] w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-1.5 py-0 text-[11px] leading-none font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3",
 {
 variants: {
 variant: {
 // LOCAL ADAPTATION: the plugin's own status chips are a FLAT TINT with the
    // state ink (see sidebar.module.css `.explorerRowRevealed`), not a solid
    // primary fill — a solid badge is the loudest thing on every row here.
    default: "bg-state-business-tertiary text-state-business-primary [a&]:hover:bg-state-business-tertiary",
 secondary:
 "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
 destructive:
 "bg-destructive text-destructive-foreground focus-visible:ring-destructive/20 [a&]:hover:bg-destructive/90",
 outline:
 "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
 ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
 link: "text-primary underline-offset-4 [a&]:hover:underline",
 },
 },
 defaultVariants: {
 variant: "default",
 },
 }
)

function Badge({
 className,
 variant = "default",
 asChild = false,
 ...props
}: React.ComponentProps<"span"> &
 VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
 const Comp = asChild ? Slot.Root : "span"

 return (
 <Comp
 data-slot="badge"
 data-variant={variant}
 className={cn(badgeVariants({ variant }), className)}
 {...props}
 />
 )
}

export { Badge, badgeVariants }
