import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/lib/utils"

interface SliderProps extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  formatLabel?: (value: number) => string;
}

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(({ className, formatLabel, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex w-full touch-none select-none items-center",
      className
    )}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    {props.value?.map((val, i) => (
      <SliderPrimitive.Thumb
        key={i}
        className="group block h-5 w-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 relative"
      >
        {formatLabel && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 rounded bg-primary px-2 py-1 text-[10px] font-bold text-primary-foreground whitespace-nowrap shadow-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100 group-active:opacity-100 data-[state=dragging]:opacity-100">
            {formatLabel(val)}
          </div>
        )}
      </SliderPrimitive.Thumb>
    ))}
    {props.children}
  </SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
