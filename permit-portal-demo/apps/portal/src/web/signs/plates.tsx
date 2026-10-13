// The portal's sign system: graphite plates with full-white type, sign green for
// open, and never no-entry red in the portal (the Red Stays in Permit rule).

import type { ComponentType, ReactNode, SVGProps } from "react"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

type Icon = ComponentType<SVGProps<SVGSVGElement>>

/**
 * A full-height sign: an identifier and its details, with an optional status segment.
 */
export function SignPlate({
  id,
  title,
  children,
  aside,
}: {
  id: string
  title: string
  children?: ReactNode
  aside?: { icon: Icon; text: string } | undefined
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid overflow-hidden rounded-md border border-plate-edge bg-plate text-on-plate sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="flex min-w-0 flex-col gap-4 px-6 py-5">
        <h1 id={id} className="text-[2.6rem] leading-none font-black tracking-tight break-words">
          {title}
        </h1>
        {children}
      </div>
      {aside !== undefined && (
        <div className="flex items-center gap-4 border-t border-on-plate px-6 py-5 sm:max-w-64 sm:border-t-0 sm:border-l">
          <span className="grid size-12 shrink-0 place-items-center rounded-sm border-2 border-on-plate">
            <aside.icon aria-hidden className="size-7" />
          </span>
          <span className="text-xl leading-tight font-extrabold">{aside.text}</span>
        </div>
      )}
    </section>
  )
}

export type PlateTone = "go" | "graphite"

/** The square state plate that leads a gate sign: green "Open", or graphite for any other state. */
export function StatePlate({
  tone,
  icon: PlateIcon,
  label,
}: {
  tone: PlateTone
  icon: Icon
  label: string
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-sm px-4 py-3 text-lg font-extrabold",
        tone === "go" ? "bg-go text-on-state" : "border border-plate-edge bg-plate text-on-plate",
      )}
    >
      <PlateIcon aria-hidden className="size-6" />
      {label}
    </div>
  )
}

/**
 * A gate sign: state plate, the sentence that explains it, an optional clock and an optional
 * action.
 */
export function GateSign({
  tone,
  icon,
  label,
  title,
  detail,
  clock,
  action,
  children,
}: {
  tone: PlateTone
  icon: Icon
  label: string
  title: string
  detail?: string
  clock?: { value: string; caption: string } | undefined
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-stretch gap-3">
        <StatePlate tone={tone} icon={icon} label={label} />
        {clock !== undefined && (
          <div className="ml-auto flex flex-col items-end justify-center sm:order-3 sm:ml-0">
            <span className="text-[2.4rem] leading-none font-black">{clock.value}</span>
            <span className="text-sm text-muted-foreground">{clock.caption}</span>
          </div>
        )}
        <div className="flex min-w-0 basis-full flex-col justify-center sm:order-2 sm:basis-auto sm:flex-1">
          <h2 className="text-xl font-extrabold">{title}</h2>
          {detail !== undefined && <p className="text-base text-muted-foreground">{detail}</p>}
        </div>
        {action !== undefined && <div className="flex items-center sm:order-4">{action}</div>}
      </div>
      {children}
    </section>
  )
}

export interface Stage {
  label: string
  detail: string
  when?: string
  state: "done" | "current" | "next"
}

/**
 * Fixed-scale stages on one baseline. `compact` sizes each cell to its
 * text so a request's lifecycle fits in its header, where a status chip would otherwise sit.
 */
export function StageStrip({
  label,
  stages,
  compact = false,
}: {
  label: string
  stages: Stage[]
  compact?: boolean
}) {
  return (
    <ol
      aria-label={label}
      className={cn(
        compact ? "flex flex-wrap gap-1.5" : "grid grid-cols-2 gap-2",
        !compact && (stages.length >= 4 ? "sm:grid-cols-4" : "sm:grid-cols-3"),
      )}
    >
      {stages.map((stage) => {
        const muted = stage.state !== "current" && "text-muted-foreground"
        return (
          <li
            key={stage.label}
            aria-current={stage.state === "current" ? "step" : undefined}
            className={cn(
              "flex flex-col rounded-sm",
              compact ? "px-2.5 py-1.5 text-sm" : "px-3 py-2",
              stage.state === "current"
                ? "border border-plate-edge bg-plate text-on-plate"
                : "border border-border bg-surface",
            )}
          >
            <span className="flex items-center gap-1.5 font-bold">
              {stage.state === "done" && (
                <CheckIcon aria-hidden className={compact ? "size-3.5" : "size-4"} />
              )}
              {stage.label}
            </span>
            <span className={cn(!compact && "text-sm", muted)}>{stage.detail}</span>
            {stage.when !== undefined && (
              <span className={cn(!compact && "text-sm", muted)}>{stage.when}</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** A heading for a section of a portal page, with an optional action on the right. */
export function SectionHeading({
  id,
  title,
  action,
}: {
  id: string
  title: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id={id} className="text-xl font-extrabold">
        {title}
      </h2>
      {action}
    </div>
  )
}

/** What a page shows in place of details it may no longer show. */
export function HiddenDetails({
  icon: HiddenIcon,
  title,
  children,
}: {
  icon: Icon
  title: string
  children: ReactNode
}) {
  return (
    <section
      aria-live="polite"
      className="flex items-start gap-4 rounded-md border border-dashed border-border bg-surface px-6 py-6"
    >
      <HiddenIcon aria-hidden className="mt-0.5 size-6 shrink-0" />
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-extrabold">{title}</h2>
        <div className="max-w-[60ch] text-base text-muted-foreground">{children}</div>
      </div>
    </section>
  )
}
