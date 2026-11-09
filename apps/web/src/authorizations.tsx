import type { AgentToken, OAuthGrant } from "@shazhou/pinboard-contracts";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon.js";

export function tokenStatus(token: AgentToken, now = Date.now()) {
  return token.revokedAt !== null
    ? "Revoked"
    : Date.parse(token.expiresAt) <= now
      ? "Expired"
      : "Active";
}

export function grantStatus(grant: OAuthGrant, now = Date.now()) {
  if (grant.revokedAt !== null) return "Revoked";
  if (grant.expiresAt !== null && grant.expiresAt <= now) return "Expired";
  if (!grant.tokenIssued)
    return grant.codeExpiresAt <= now ? "Expired" : "Awaiting code exchange";
  return "Active";
}

export function authorizationMatches(
  name: string,
  scopes: string,
  status: string,
  query: string,
  includeInactive: boolean,
) {
  return (
    (includeInactive ||
      status === "Active" ||
      status === "Awaiting code exchange") &&
    `${name} ${scopes}`.toLowerCase().includes(query.trim().toLowerCase())
  );
}

export async function fetchTokenViews(
  read: (view: "active" | "history") => Promise<{ tokens: AgentToken[] }>,
  includeInactive: boolean,
) {
  const lists = await Promise.all([
    read("active"),
    ...(includeInactive ? [read("history")] : []),
  ]);
  // Prefer the later history snapshot if expiry/revocation crossed the requests.
  return [
    ...new Map(
      lists.flatMap((list) => list.tokens).map((token) => [token.id, token]),
    ).values(),
  ];
}

export function AuthorizationToolbar({
  name,
  query,
  onQuery,
  includeInactive,
  onIncludeInactive,
  disabled,
  action,
}: {
  name: string;
  query: string;
  onQuery: (query: string) => void;
  includeInactive: boolean;
  onIncludeInactive: (include: boolean) => void;
  disabled: boolean;
  action: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const toggle = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    toggle.current?.focus();
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !box.current?.contains(event.target)
      ) {
        setOpen(false);
        if (box.current?.contains(document.activeElement))
          button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="authorization-toolbar"
      role="group"
      aria-label={`${name} toolbar`}
    >
      <div
        className="authorization-filter"
        ref={box}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setOpen(false);
        }}
        onKeyDown={(event) => {
          if (open && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            button.current?.focus();
          }
        }}
      >
        <input
          type="search"
          aria-label={`Search ${name}`}
          placeholder="Filter by name or permissions"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        <button
          ref={button}
          type="button"
          className={`glyph-button${includeInactive ? " filter-active" : ""}`}
          title={`${name} filter options${includeInactive ? " (including inactive)" : ""}`}
          aria-label={`${name} filter options${includeInactive ? " (including inactive)" : ""}`}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          <Icon name="filter" />
        </button>
        {open && (
          <div id={id} className="authorization-filter-menu">
            <label className="authorization-switch">
              <input
                ref={toggle}
                type="checkbox"
                role="switch"
                checked={includeInactive}
                disabled={disabled}
                onChange={(event) => onIncludeInactive(event.target.checked)}
              />
              Show inactive authorizations
            </label>
            <small>Includes expired and revoked records</small>
          </div>
        )}
      </div>
      {action}
    </div>
  );
}

export function AuthorizationTable({
  name,
  firstColumn,
  children,
  loading = false,
  error = "",
  empty = "",
  retry,
}: {
  name: string;
  firstColumn: string;
  children: ReactNode;
  loading?: boolean;
  error?: string;
  empty?: string;
  retry?: ReactNode;
}) {
  return (
    <SettingsTable
      name={name}
      columns={[firstColumn, "Permissions", "Expires", "Status", "Actions"]}
      loading={loading}
      error={error}
      empty={empty}
      retry={retry}
    >
      {children}
    </SettingsTable>
  );
}

export function SettingsTable({
  name,
  columns,
  children,
  loading = false,
  error = "",
  empty = "",
  retry,
  className = "",
}: {
  name: string;
  columns: readonly string[];
  children: ReactNode;
  loading?: boolean;
  error?: string;
  empty?: string;
  retry?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`authorization-table-scroll${className ? ` ${className}` : ""}`}
      role="region"
      aria-label={`${name} table (scrollable)`}
      tabIndex={0}
    >
      <table aria-label={name}>
        <thead>
          <tr>
            {columns.map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading || error || empty ? (
            <tr>
              <td colSpan={columns.length} className="authorization-empty">
                {loading ? (
                  <p role="status">Loading {name}...</p>
                ) : error ? (
                  <>
                    <p role="alert">{error}</p>
                    {retry}
                  </>
                ) : (
                  <p>{empty}</p>
                )}
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}
