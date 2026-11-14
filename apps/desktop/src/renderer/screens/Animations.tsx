import { useEffect, useState } from "react";
import type { AnimationSummary, StudioStatus } from "../../shared/api.js";
import { Dropdown } from "../components/Dropdown.js";
import { ChevronDownIcon, FolderIcon } from "../components/Icons.js";
import { Pill } from "../components/Pill.js";
import { now } from "../lib/clock.js";
import {
  formatDuration,
  metaLine,
  packColor,
  renderingLabel,
  SORT_LABELS,
  type SortOrder,
  sceneCount,
  sortAnimations,
} from "../lib/format.js";
import { overrides } from "../lib/overrides.js";
import "./Animations.css";

interface AnimationsProps {
  animations: AnimationSummary[] | undefined;
  status: StudioStatus | undefined;
  onOpen: (id: string) => void;
  onConnect: () => void;
}

/** The thumbnail: the rendered image, or the name on a plain fill until it loads (or fails). */
export function Thumbnail({ animation }: { animation: AnimationSummary }) {
  const { id, version, name } = animation;
  const [loaded, setLoaded] = useState(false);
  // A new version is a new image: start from the plain fill again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the trigger
  useEffect(() => setLoaded(false), [version]);
  const artwork = overrides().artwork?.(id, "thumb");
  if (artwork !== undefined) return <span className="thumb__art">{artwork}</span>;
  return (
    <>
      {loaded ? null : <span className="thumb__name">{name}</span>}
      <img
        className="thumb__img"
        src={window.kynimo.studio.thumbnailUrl(id, version)}
        alt=""
        data-loaded={loaded}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(false)}
      />
    </>
  );
}

function Card({
  animation,
  status,
  onOpen,
}: {
  animation: AnimationSummary;
  status: StudioStatus | undefined;
  onOpen: (id: string) => void;
}) {
  const { activity } = animation;
  const agent = status?.client?.name ?? animation.createdBy ?? "Your agent";
  let meta = metaLine(animation.createdBy, animation.updatedAt, now());
  if (activity?.kind === "rendering") meta = `${agent} is rendering · just now`;
  else if (activity?.kind === "checking") meta = `${activity.client} is checking frames · just now`;
  const rendering = activity?.kind === "rendering" ? activity.progress : undefined;
  const percent = rendering === undefined ? 0 : Math.round(rendering * 100);

  return (
    <li className="cardwrap">
      <button type="button" className="card" onClick={() => onOpen(animation.id)}>
        <span className={`thumb${rendering === undefined ? "" : " thumb--busy"}`}>
          <Thumbnail animation={animation} />
          {rendering === undefined ? null : (
            <>
              <span className="thumb__dim" style={{ left: `round(${percent}%, 1px)` }} />
              <span className="thumb__progress" style={{ width: `round(${percent}%, 1px)` }} />
              <span className="thumb__playhead" style={{ left: `round(${percent}%, 1px)` }} />
              <Pill className="thumb__pill">{renderingLabel(rendering)}</Pill>
            </>
          )}
        </span>
        <span className="card__meta">
          <span className="card__text">
            <span className="card__title">{animation.name}</span>
            {meta === "" ? null : <span className="card__sub">{meta}</span>}
          </span>
          {rendering === undefined ? (
            <span className="card__length">
              <span className="card__dot" style={{ background: packColor(animation.style) }} />
              <span className="mono">{formatDuration(animation.durationSec)}</span>
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** The library: every animation as a card, with sort and a way to the folder. */
export function Animations({ animations, status, onOpen, onConnect }: AnimationsProps) {
  const [order, setOrder] = useState<SortOrder>("latest");
  const list = animations === undefined ? [] : sortAnimations(animations, order);
  const empty = animations !== undefined && animations.length === 0;

  return (
    <div className="animations">
      <header className="animations__head">
        <h1 className="animations__title display">Animations</h1>
        {animations === undefined || empty ? null : (
          <p className="animations__count mono">{sceneCount(animations)}</p>
        )}
        <div className="animations__spacer" />
        {empty || animations === undefined ? null : (
          <Dropdown
            label="Sort"
            align="right"
            triggerClassName="btn btn--outline"
            trigger={
              <>
                {SORT_LABELS[order]}
                <ChevronDownIcon />
              </>
            }
            items={(Object.keys(SORT_LABELS) as SortOrder[]).map((key) => ({
              key,
              label: SORT_LABELS[key],
              checked: key === order,
              onSelect: () => setOrder(key),
            }))}
          />
        )}
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => void window.kynimo.studio.openProjectsFolder()}
        >
          <FolderIcon className="btn__icon" />
          Open folder
        </button>
      </header>
      {empty ? (
        <section className="empty" aria-labelledby="empty-title">
          <h2 id="empty-title" className="empty__title display">
            Nothing here yet.
          </h2>
          <p className="empty__body">
            Ask your agent for a video. It shows up here as soon as it's built.
          </p>
          <button type="button" className="btn btn--primary" onClick={onConnect}>
            Connect your agent
          </button>
        </section>
      ) : (
        <ul className="grid">
          {list.map((a) => (
            <Card key={a.id} animation={a} status={status} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}
