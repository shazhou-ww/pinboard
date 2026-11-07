import { useEffect, useState, type ReactNode } from "react";

export const loadingFadeDuration = 320;
export const loadingQuoteInterval = 2600;
const quotes = [
  ["Keep what matters.", "Let the noise pass."],
  ["Your content. Your address.", "Your choice."],
  ["A link to content,", "not another feed."],
  ["Pin once.", "Share without the noise."],
  ["Small tools.", "More room for your things."],
] as const;

export function LoadingIndicator({
  label,
  compact = false,
  active = true,
}: {
  readonly label: string;
  readonly compact?: boolean;
  readonly active?: boolean;
}) {
  const [quoteIndex, setQuoteIndex] = useState(0);
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    if (compact || !active) return;
    let swap: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      setChanging(true);
      swap = setTimeout(() => {
        setQuoteIndex((index) => (index + 1) % quotes.length);
        setChanging(false);
      }, loadingFadeDuration / 2);
    }, loadingQuoteInterval);
    return () => {
      clearInterval(timer);
      clearTimeout(swap);
    };
  }, [compact, active]);
  const quote = quotes[quoteIndex]!;
  return (
    <div
      className={`loading-indicator${compact ? " loading-indicator-compact" : ""}`}
      role="status"
      aria-label={label}
    >
      {compact ? (
        <span className="loading-spinner" aria-hidden="true" />
      ) : (
        <div className="loading-editorial" aria-hidden="true">
          <p className="loading-eyebrow">A quiet thought, while you wait</p>
          <div className="loading-thought">
            <p
              className={`loading-quote${active && changing ? " changing" : ""}`}
            >
              {quote[0]} <em>{quote[1]}</em>
            </p>
          </div>
          <div className="loading-colophon">
            <span className="loading-spinner" aria-hidden="true" />
            <span>A note from Pinboard</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function LoadingReveal({
  loading,
  label,
  className = "",
  children,
}: {
  readonly loading: boolean;
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const [retained, setRetained] = useState(loading);
  useEffect(() => {
    if (loading) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRetained(false);
      return;
    }
    const timer = setTimeout(() => setRetained(false), loadingFadeDuration);
    return () => clearTimeout(timer);
  }, [loading, retained]);
  const pending = loading || retained;
  return (
    <div className={`loading-reveal${className ? ` ${className}` : ""}`}>
      {pending ? (
        <div
          className={`loading-reveal-overlay${loading ? "" : " leaving"}`}
          style={{ animationDuration: `${loadingFadeDuration}ms` }}
          onAnimationEnd={(event) => {
            if (!loading && event.target === event.currentTarget)
              setRetained(false);
          }}
        >
          <LoadingIndicator label={label} active={loading} />
        </div>
      ) : null}
      <div
        className="loading-reveal-content"
        hidden={pending}
        style={{ animationDuration: `${loadingFadeDuration}ms` }}
      >
        {children}
      </div>
    </div>
  );
}
