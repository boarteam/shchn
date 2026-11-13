import { useLayoutEffect, useRef } from "react";
import type { SessionState } from "./useSession";

// What happened, newest at the bottom: applied edits, finished calls, warnings.
// The same lines the terminal prints.

export function Activity({ state }: { state: SessionState }) {
  const list = useRef<HTMLOListElement>(null);
  // Follow new entries, unless the reader has scrolled up to look at older ones.
  const following = useRef(true);

  useLayoutEffect(() => {
    const element = list.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [state.feed]);

  return (
    <section className="panel activity-panel" aria-label="Activity">
      <div className="panel-head">
        <h2>Activity</h2>
      </div>
      <ol
        className="feed"
        ref={list}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {state.feed.length === 0 ? <li className="feed-empty">Edits and calls appear here as they happen.</li> : null}
        {state.feed.map((entry) => (
          <li key={entry.id} className={`feed-${entry.kind}`}>
            <time>{entry.at}</time>
            <span>
              {entry.fromReview ? <em>review </em> : null}
              {entry.kind === "warn" ? `! ${entry.text}` : entry.text}
            </span>
          </li>
        ))}
      </ol>
      {state.heard ? (
        <p className="heard">
          <span>heard</span> {state.heard}
        </p>
      ) : null}
      {state.error ? (
        <p className="error session-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.summary.length > 0 ? (
        <div className="summary">
          <h3>Summary</h3>
          <pre>{state.summary.join("\n")}</pre>
        </div>
      ) : null}
    </section>
  );
}
