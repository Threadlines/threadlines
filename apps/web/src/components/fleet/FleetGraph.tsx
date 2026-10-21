import {
  LaptopIcon,
  type LucideIcon,
  MonitorIcon,
  ServerIcon,
  SmartphoneIcon,
  TabletIcon,
} from "lucide-react";
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { ProviderGlyph } from "../chat/ProviderInstanceIcon";
import {
  describeComputerLocation,
  type FleetComputer,
  type FleetGlyph,
  type FleetLineState,
  type FleetModel,
  type FleetProvider,
  type FleetWork,
  resolveProviderLineState,
} from "./fleet.logic";
import type { FleetGraphEdge } from "./fleetLinks.logic";
import {
  buildTravelingDotKeyframes,
  curvePath,
  FLEET_COMPUTER_NODE_RADIUS,
  FLEET_DOT_CYCLE_SECONDS,
  FLEET_GRAPH_MAX_COMPUTERS,
  FLEET_GRAPH_MAX_MOVING_LINES,
  FLEET_GRAPH_MAX_PROVIDERS,
  FLEET_PROVIDER_NODE_RADIUS,
  layoutFleetGraph,
  type Point,
  travelingDotDelaySeconds,
} from "./fleetGraph.logic";

export const FLEET_GLYPH_ICONS: Record<FleetGlyph, LucideIcon> = {
  laptop: LaptopIcon,
  monitor: MonitorIcon,
  server: ServerIcon,
  phone: SmartphoneIcon,
  tablet: TabletIcon,
};

const RING_CLASS: Record<FleetWork, string> = {
  working: "border-primary-graph",
  "needs-you": "border-amber-500 dark:border-amber-300",
  idle: "border-border",
};

export const FLEET_CONNECTION_DOT_CLASS = {
  connected: "bg-success",
  reconnecting: "bg-warning",
  offline: "bg-muted-foreground",
} as const;

/** The stage's width, measured; null until the first layout. */
function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      // Whole pixels, in steps of two: a resize re-lays the graph (and its
      // keyframes) only when something visible would move.
      const next = Math.round(element.getBoundingClientRect().width / 2) * 2;
      setWidth((current) => (current === next ? current : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** True while the window has focus and the page is visible: the dots only move then. */
function readWindowActive(): boolean {
  return typeof document === "undefined"
    ? true
    : document.visibilityState === "visible" && document.hasFocus();
}

function useWindowActive(): boolean {
  const [active, setActive] = useState(readWindowActive);
  useEffect(() => {
    const update = () => setActive(readWindowActive());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return active;
}

interface GraphLine {
  readonly key: string;
  readonly from: Point;
  readonly to: Point;
  readonly fromRadius: number;
  readonly toRadius: number;
  readonly state: FleetLineState;
}

/** A line's look by state: what each one means is in the legend. */
function FleetLinePath({ d, state }: { readonly d: string; readonly state: FleetLineState }) {
  switch (state) {
    case "working":
      return (
        <g data-line-state="working">
          <path
            d={d}
            className="fill-none stroke-primary-graph"
            strokeOpacity={0.2}
            strokeWidth={1.5}
          />
          <path
            d={d}
            className="fill-none stroke-primary-graph"
            strokeOpacity={0.75}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeDasharray="0.1 7"
          />
        </g>
      );
    case "needs-you":
      return (
        <path
          data-line-state="needs-you"
          d={d}
          className="fill-none stroke-amber-500 dark:stroke-amber-300"
          strokeWidth={1.5}
        />
      );
    case "connected":
      return (
        <path
          data-line-state="connected"
          d={d}
          className="fill-none stroke-muted-foreground"
          strokeOpacity={0.5}
          strokeWidth={1.25}
        />
      );
    case "reconnecting":
      return (
        <path
          data-line-state="reconnecting"
          d={d}
          className="fill-none stroke-amber-500 dark:stroke-amber-300"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
      );
    case "offline":
      return (
        <path
          data-line-state="offline"
          d={d}
          className="fill-none stroke-muted-foreground"
          strokeOpacity={0.35}
          strokeWidth={1.25}
          strokeDasharray="3 4"
        />
      );
  }
}

function ComputerNode({
  computer,
  position,
  nowMs,
  onOpen,
}: {
  readonly computer: FleetComputer;
  readonly position: Point;
  readonly nowMs: number;
  readonly onOpen: ((computer: FleetComputer) => void) | null;
}) {
  const Glyph = FLEET_GLYPH_ICONS[computer.glyph];
  // Offline: quiet text, but the node stays opaque so lines never show through it.
  const quiet = computer.connection === "offline";
  const location = describeComputerLocation(computer, nowMs);
  const body = (
    <>
      <span
        className={cn(
          "relative flex size-[42px] items-center justify-center rounded-full border-[1.5px] bg-card transition-colors",
          RING_CLASS[computer.work],
          // The hover tint is painted over the solid fill (an inset shadow),
          // never instead of it: a see-through fill lets the lines show through.
          onOpen !== null && "group-hover/node:shadow-[inset_0_0_0_21px_var(--accent)]",
        )}
      >
        <Glyph
          aria-hidden="true"
          className={cn("size-4", quiet ? "text-muted-foreground" : "text-foreground")}
        />
        <span
          aria-hidden="true"
          data-testid={`fleet-connection-${computer.connection}`}
          className={cn(
            "absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-card",
            FLEET_CONNECTION_DOT_CLASS[computer.connection],
          )}
        />
      </span>
      <span
        className={cn(
          "mt-1.5 text-[12.5px] leading-4 font-semibold whitespace-nowrap transition-colors",
          quiet ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {computer.label}
      </span>
      {location ? (
        <span className="font-mono text-[10.5px] leading-4 whitespace-nowrap text-muted-foreground">
          {location}
        </span>
      ) : null}
    </>
  );
  const className = "absolute flex -translate-x-1/2 flex-col items-center rounded-lg";
  const style = { left: position.x, top: position.y - FLEET_COMPUTER_NODE_RADIUS };
  if (onOpen === null) {
    return (
      <div className={className} style={style} data-testid={`fleet-node-${computer.id}`}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={
        computer.kind === "device"
          ? `${computer.label}: open Connections settings`
          : `Open ${computer.label}`
      }
      data-testid={`fleet-node-${computer.id}`}
      className={cn(className, "group/node cursor-pointer focus-ring")}
      style={style}
      onClick={() => onOpen(computer)}
    >
      {body}
    </button>
  );
}

function ProviderNode({
  provider,
  label,
  position,
  above,
}: {
  readonly provider: FleetProvider;
  readonly label: string;
  readonly position: Point;
  readonly above: boolean;
}) {
  const count = provider.needsYou > 0 ? provider.needsYou : provider.working;
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: position.x, top: position.y }}
      data-testid={`fleet-provider-${provider.key}`}
    >
      <span
        className={cn(
          "relative flex size-7 items-center justify-center rounded-full border-[1.5px] bg-card text-foreground",
          RING_CLASS[provider.work],
        )}
      >
        <ProviderGlyph
          instanceId={provider.instanceId}
          driverKind={provider.driverKind}
          environmentId={provider.environmentId}
          className="size-3.5"
        />
        {count > 0 ? (
          <span
            className={cn(
              "absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] leading-none font-semibold tabular-nums",
              // Dark text on the amber and on dark mode's light blue: white
              // would fall under 4.5:1 on both.
              provider.needsYou > 0
                ? "bg-amber-500 text-amber-950"
                : "bg-primary-graph text-white dark:text-background",
            )}
          >
            {count}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "absolute left-1/2 -translate-x-1/2 text-[11px] leading-4 whitespace-nowrap text-muted-foreground",
          above ? "bottom-full mb-0.5" : "top-full mt-0.5",
        )}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * The fleet as a graph: this computer in the middle, the other computers and
 * linked devices around it, and each computer's agents fanned out from it.
 * Lines say what is happening on them (see the legend): this app's
 * connections from the middle, links between the other computers, and work
 * one computer asked of another. A working line carries a traveling dot from
 * the asking side to the working one; the dots stop while the window is in
 * the background and never run under reduced motion.
 */
export function FleetGraph({
  model,
  edges,
  nowMs,
  height,
  onOpenComputer,
  providerLabel,
}: {
  readonly model: FleetModel;
  /** The lines between computers (fleetLinks.logic buildFleetGraphEdges). */
  readonly edges: ReadonlyArray<FleetGraphEdge>;
  readonly nowMs: number;
  readonly height: number;
  readonly onOpenComputer: (computer: FleetComputer) => void;
  readonly providerLabel: (provider: FleetProvider) => string;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(stageRef);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const windowActive = useWindowActive();
  const scope = `fleet-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const others = useMemo(() => model.others.slice(0, FLEET_GRAPH_MAX_COMPUTERS), [model.others]);
  const centerProviders = useMemo(
    () => model.center.providers.slice(0, FLEET_GRAPH_MAX_PROVIDERS),
    [model.center.providers],
  );

  // Where each drawn computer sits in the layout: -1 for the center.
  const indexById = useMemo(() => {
    const byId = new Map<string, number>([[model.center.id, -1]]);
    others.forEach((computer, index) => byId.set(computer.id, index));
    return byId;
  }, [model.center.id, others]);
  const drawnEdges = useMemo(
    () => edges.filter((edge) => indexById.has(edge.fromId) && indexById.has(edge.toId)),
    [edges, indexById],
  );

  const layout = useMemo(
    () =>
      width === null
        ? null
        : layoutFleetGraph({
            width,
            height,
            centerProviderCount: centerProviders.length,
            otherProviderCounts: others.map((computer) =>
              computer.kind === "device" ? 0 : computer.providers.length,
            ),
            // Lines between two other computers: agents keep clear of them too.
            otherLines: drawnEdges.flatMap((edge) => {
              const from = indexById.get(edge.fromId)!;
              const to = indexById.get(edge.toId)!;
              return from >= 0 && to >= 0 ? [[from, to] as const] : [];
            }),
          }),
    [centerProviders.length, drawnEdges, height, indexById, others, width],
  );

  const lines = useMemo((): GraphLine[] => {
    if (layout === null) return [];
    const positionOf = (id: string) => {
      const index = indexById.get(id)!;
      return index < 0 ? layout.center : layout.others[index]!;
    };
    const result: GraphLine[] = drawnEdges.map((edge) => ({
      key: edge.key,
      from: positionOf(edge.fromId),
      to: positionOf(edge.toId),
      fromRadius: FLEET_COMPUTER_NODE_RADIUS,
      toRadius: FLEET_COMPUTER_NODE_RADIUS,
      state: edge.state,
    }));
    centerProviders.forEach((provider, index) => {
      result.push({
        key: `provider:${model.center.id}:${provider.key}`,
        from: layout.center,
        to: layout.centerProviders[index]!,
        fromRadius: FLEET_COMPUTER_NODE_RADIUS,
        toRadius: FLEET_PROVIDER_NODE_RADIUS,
        state: resolveProviderLineState(model.center, provider),
      });
    });
    others.forEach((computer, index) => {
      const positions = layout.otherProviders[index] ?? [];
      computer.providers.slice(0, positions.length).forEach((provider, providerIndex) => {
        result.push({
          key: `provider:${computer.id}:${provider.key}`,
          from: layout.others[index]!,
          to: positions[providerIndex]!,
          fromRadius: FLEET_COMPUTER_NODE_RADIUS,
          toRadius: FLEET_PROVIDER_NODE_RADIUS,
          state: resolveProviderLineState(computer, provider),
        });
      });
    });
    return result;
  }, [centerProviders, drawnEdges, indexById, layout, model.center, others]);

  const moving = useMemo(
    () =>
      reducedMotion
        ? []
        : lines.filter((line) => line.state === "working").slice(0, FLEET_GRAPH_MAX_MOVING_LINES),
    [lines, reducedMotion],
  );
  const dotStyles = useMemo(() => {
    if (moving.length === 0) return "";
    const keyframes = moving
      .map((line, index) => {
        const frames = buildTravelingDotKeyframes(`${scope}-${index}`, line);
        return frames.dot + frames.ring;
      })
      .join("");
    return [
      `.${scope} .fleet-dot,.${scope} .fleet-ring{position:absolute;left:0;top:0;opacity:0;will-change:transform,opacity}`,
      `.${scope} .fleet-dot>i{position:absolute;left:-8px;top:-8px;width:16px;height:16px;border-radius:50%;background:radial-gradient(circle,color-mix(in oklab,var(--primary-graph) 55%,white) 0 2.5px,var(--primary-graph) 3.5px,color-mix(in oklab,var(--primary-graph) 35%,transparent) 4.5px,transparent 8px)}`,
      `.${scope} .fleet-dot.trail-1>i{transform:scale(.7);opacity:.45}`,
      `.${scope} .fleet-dot.trail-2>i{transform:scale(.5);opacity:.2}`,
      `.${scope} .fleet-ring>i{position:absolute;border-radius:50%;box-shadow:0 0 0 1.5px var(--primary-graph)}`,
      `.${scope}[data-paused] .fleet-dot,.${scope}[data-paused] .fleet-ring{animation-play-state:paused}`,
      keyframes,
    ].join("\n");
  }, [moving, scope]);

  return (
    <div
      ref={stageRef}
      className="relative w-full select-none"
      style={{ height }}
      data-testid="fleet-graph"
    >
      {layout === null ? null : (
        <>
          <svg
            aria-hidden="true"
            className="absolute inset-0"
            width={width ?? 0}
            height={height}
            viewBox={`0 0 ${width ?? 0} ${height}`}
          >
            {lines.map((line) => (
              <FleetLinePath key={line.key} d={curvePath(line.from, line.to)} state={line.state} />
            ))}
          </svg>
          {moving.length > 0 ? (
            <div
              aria-hidden="true"
              className={cn(scope, "pointer-events-none absolute inset-0")}
              data-paused={windowActive ? undefined : ""}
              data-testid="fleet-traveling-dots"
            >
              <style>{dotStyles}</style>
              {moving.map((line, index) => {
                const name = `${scope}-${index}`;
                const delay = travelingDotDelaySeconds(index);
                const ringSize = line.toRadius * 2 + 6;
                return (
                  <div key={line.key}>
                    {[0, 1, 2].map((trail) => (
                      <div
                        key={trail}
                        className={cn("fleet-dot", trail > 0 && `trail-${trail}`)}
                        style={{
                          animation: `${name} ${FLEET_DOT_CYCLE_SECONDS}s linear ${(delay + trail * 0.07).toFixed(2)}s infinite`,
                        }}
                      >
                        <i />
                      </div>
                    ))}
                    <div
                      className="fleet-ring"
                      style={{
                        animation: `${name}-ring ${FLEET_DOT_CYCLE_SECONDS}s linear ${delay.toFixed(2)}s infinite`,
                      }}
                    >
                      <i
                        style={{
                          left: -ringSize / 2,
                          top: -ringSize / 2,
                          width: ringSize,
                          height: ringSize,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          {centerProviders.map((provider, index) => (
            <ProviderNode
              key={`${model.center.id}:${provider.key}`}
              provider={provider}
              label={providerLabel(provider)}
              position={layout.centerProviders[index]!}
              above={layout.centerProviders[index]!.y < layout.center.y}
            />
          ))}
          {others.map((computer, index) =>
            computer.providers
              .slice(0, layout.otherProviders[index]?.length ?? 0)
              .map((provider, providerIndex) => {
                const position = layout.otherProviders[index]![providerIndex]!;
                return (
                  <ProviderNode
                    key={`${computer.id}:${provider.key}`}
                    provider={provider}
                    label={providerLabel(provider)}
                    position={position}
                    above={position.y < layout.others[index]!.y}
                  />
                );
              }),
          )}
          <ComputerNode
            computer={model.center}
            position={layout.center}
            nowMs={nowMs}
            onOpen={model.center.environmentId === null ? null : onOpenComputer}
          />
          {others.map((computer, index) => (
            <ComputerNode
              key={computer.id}
              computer={computer}
              position={layout.others[index]!}
              nowMs={nowMs}
              onOpen={onOpenComputer}
            />
          ))}
        </>
      )}
    </div>
  );
}

function LegendSample({ state }: { readonly state: FleetLineState }) {
  return (
    <svg aria-hidden="true" width={24} height={8} className="shrink-0">
      <FleetLinePath d="M1 4L23 4" state={state} />
    </svg>
  );
}

const LEGEND: ReadonlyArray<{ readonly state: FleetLineState; readonly label: string }> = [
  { state: "working", label: "Working" },
  { state: "needs-you", label: "Needs you" },
  { state: "connected", label: "Connected" },
  { state: "reconnecting", label: "Reconnecting" },
  { state: "offline", label: "Offline" },
];

/** What the lines mean, under the graph. */
export function FleetGraphLegend({ hint }: { readonly hint: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {LEGEND.map((entry) => (
        <span key={entry.state} className="flex items-center gap-1.5">
          <LegendSample state={entry.state} />
          {entry.label}
        </span>
      ))}
      {hint ? <span className="ms-auto">{hint}</span> : null}
    </div>
  );
}
