"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { SignOutButton } from "./SignOutButton";

type Notice = {
  id: string;
  subject: string;
  body: string;
  isRead: boolean;
  createdAt: string;
  caseId: string | null;
};
type NavItem = { href: string; label: string; icon: IconName };
export function AppShell({
  children,
  email,
  roles,
  institution,
  notices,
  unread,
  signOutAction,
  readAction,
}: {
  children: ReactNode;
  email: string | null;
  roles: string[];
  institution: string;
  notices: Notice[];
  unread: number;
  signOutAction: () => Promise<void>;
  readAction: (id: string) => Promise<void>;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, startTransition] = useTransition();
  const [noticeError, setNoticeError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const mobileDialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const staff = roles.some((r) =>
    ["admin", "officer", "investigator", "dpo"].includes(r),
  );
  const queue = roles.some((r) =>
    ["admin", "officer", "investigator"].includes(r),
  );
  const governance = roles.some((r) => ["admin", "dpo"].includes(r));
  const navigation: NavItem[] = [
    {
      href: staff ? "/dashboard" : "/",
      label: staff ? "Overview" : "Home",
      icon: "grid",
    },
    ...(queue
      ? [{ href: "/cases", label: "Case queue", icon: "cases" } as NavItem]
      : []),
    { href: "/policies", label: "Policy library", icon: "book" },
    ...(staff
      ? [
          {
            href: "/directory",
            label: "Campus directory",
            icon: "users",
          } as NavItem,
        ]
      : []),
    ...(governance
      ? [{ href: "/audit", label: "Audit log", icon: "shield" } as NavItem]
      : []),
  ];
  const section = navigation.find(
    (n) => n.href !== "/" && pathname.startsWith(n.href),
  );
  // A page below a section (/cases/<id>, /policies/<id>) names itself and links
  // back to its list, rather than claiming to be the list.
  const detail =
    section && pathname.length > section.href.length + 1
      ? section.href === "/cases"
        ? "Case details"
        : section.href === "/policies"
          ? "Policy"
          : "Details"
      : null;
  const current =
    section?.label ??
    (pathname.startsWith("/report/status")
      ? "Track a report"
      : pathname.startsWith("/report")
        ? "Report an incident"
        : "Welcome");
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("campuspulse-sidebar") === "collapsed");
    } catch {
      /* Optional preference. */
    }
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        dialog.current?.showModal();
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  const closeMobile = () => {
    mobileDialog.current?.close();
    setMobile(false);
  };
  const links = (
    <>
      <p className="nav-caption">Workspace</p>
      <nav aria-label="Main navigation">
        {navigation.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            title={n.label}
            aria-current={
              pathname === n.href ||
              (n.href !== "/" && pathname.startsWith(n.href + "/"))
                ? "page"
                : undefined
            }
            onClick={closeMobile}
            className="nav-link"
          >
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>
      <p className="nav-caption nav-caption-second">Reporting</p>
      <Link
        className="nav-link"
        href="/report"
        title="Report an incident"
        onClick={closeMobile}
      >
        <Icon name="plus" />
        <span>Report an incident</span>
      </Link>
      <Link
        className="nav-link"
        href="/report/status"
        title="Track a report"
        onClick={closeMobile}
      >
        <Icon name="search" />
        <span>Track a report</span>
      </Link>
    </>
  );
  const brand = (
    <Link href={staff ? "/dashboard" : "/"} className="brand" aria-label="CampusPulse home">
      <span className="brand-mark">
        <Icon name="pulse" />
      </span>
      <span>
        Campus<span className="brand-light">Pulse</span>
        <small>COMPLIANCE WORKSPACE</small>
      </span>
    </Link>
  );
  const searchDialog = (
    <dialog
      ref={dialog}
      className="command-dialog"
      aria-label="Search workspace"
      onClick={(e) => {
        if (e.target === e.currentTarget) dialog.current?.close();
      }}
    >
      <div className="command-head">
        <Icon name="search" />
        <input
          ref={searchInput}
          autoFocus
          aria-label="Search workspace"
          placeholder="Where would you like to go?"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="icon-button"
          aria-label="Close search"
          onClick={() => dialog.current?.close()}
        >
          <Icon name="close" />
        </button>
      </div>
      <p className="eyebrow">Jump to</p>
      {[
        ...navigation,
        {
          href: "/report",
          label: "Report an incident",
          icon: "plus" as IconName,
        },
        {
          href: "/report/status",
          label: "Track a report",
          icon: "search" as IconName,
        },
      ]
        .filter((n) => n.label.toLowerCase().includes(search.toLowerCase()))
        .map((n) => (
          <Link
            className="command-result"
            key={n.href}
            href={n.href}
            onClick={() => dialog.current?.close()}
          >
            <Icon name={n.icon} />
            {n.label}
            <Icon name="arrow" />
          </Link>
        ))}
      {search.trim() && (
        <div className="command-search-results">
          {queue && (
            <Link
              href={`/cases?q=${encodeURIComponent(search.trim())}`}
              onClick={() => dialog.current?.close()}
            >
              Search cases for “{search}” <Icon name="arrow" />
            </Link>
          )}
          <Link
            href={`/policies?q=${encodeURIComponent(search.trim())}`}
            onClick={() => dialog.current?.close()}
          >
            Search policies for “{search}” <Icon name="arrow" />
          </Link>
        </div>
      )}
      <p className="command-foot">
        Use Tab to move · Enter to open · Esc to close
      </p>
    </dialog>
  );
  if (!email)
    return (
      <div className="public-shell">
        <header className="public-topbar">
          {brand}
          <div className="toolbar-actions">
            <Link href="/report/status">Track a report</Link>
            <ThemeToggle />
            <Link href="/login" className="button button-secondary">
              Sign in <Icon name="arrow" />
            </Link>
          </div>
        </header>
        <div id="main-content" tabIndex={-1}>
          {children}
        </div>
        {searchDialog}
        <footer className="public-footer">
          CampusPulse <span>A clearer path from concern to resolution.</span>
        </footer>
      </div>
    );
  return (
    <div className={`workspace ${collapsed ? "sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        {brand}
        <div className="institution">
          <span className="institution-icon">
            <Icon name="home" />
          </span>
          <div>
            <strong>{institution}</strong>
            <small>Institution workspace</small>
          </div>
        </div>
        {links}
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <Icon name="shield" />
            <strong>Care in every case.</strong>
            <p>A focused space for a safer campus.</p>
          </div>
          <button
            className="nav-link collapse-button"
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              try {
                localStorage.setItem(
                  "campuspulse-sidebar",
                  next ? "collapsed" : "expanded",
                );
              } catch {}
            }}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <Icon name="panel" />
            <span>Collapse sidebar</span>
          </button>
        </div>
      </aside>
      <dialog
        ref={mobileDialog}
        className="mobile-drawer"
        aria-label="Main navigation"
        onClose={() => setMobile(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeMobile();
        }}
      >
        <div className="mobile-drawer-head">
          {brand}
          <button
            className="icon-button"
            aria-label="Close navigation"
            onClick={closeMobile}
          >
            <Icon name="close" />
          </button>
        </div>
        {links}
      </dialog>
      <div className="workspace-body">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-expanded={mobile}
              onClick={() => {
                mobileDialog.current?.showModal();
                setMobile(true);
              }}
            >
              <Icon name="menu" />
            </button>
            <span>Workspace</span>
            <Icon name="chevron" />
            {section && detail ? (
              <>
                <Link href={section.href}>{section.label}</Link>
                <Icon name="chevron" />
                <strong aria-current="page">{detail}</strong>
              </>
            ) : (
              <strong aria-current="page">{current}</strong>
            )}
          </div>
          <div className="toolbar-actions">
            <button
              className="search-trigger"
              aria-label="Search workspace"
              onClick={() => {
                dialog.current?.showModal();
                searchInput.current?.focus();
              }}
            >
              <Icon name="search" />
              <span>Search anything…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <ThemeToggle />
            <details className="popover notifications">
              <summary
                className="icon-button"
                aria-label={`Notifications, ${unread} unread`}
                title="Notifications"
              >
                <Icon name="bell" />
                {unread > 0 && <span className="notification-dot" />}
              </summary>
              <div className="popover-panel notification-panel">
                <div className="panel-heading">
                  <h2>Notifications</h2>
                  <span className="count-badge">{unread} unread</span>
                </div>
                {notices.length ? (
                  notices.map((n) => (
                    <article
                      key={n.id}
                      className={`notification-item ${n.isRead ? "" : "unread"}`}
                    >
                      <strong>{n.subject}</strong>
                      <p>{n.body}</p>
                      <div>
                        <time>
                          {new Date(n.createdAt).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "short",
                            timeZone: "UTC",
                          })}
                        </time>
                        {n.caseId && (
                          <Link href={`/cases/${n.caseId}`}>View case</Link>
                        )}
                        {!n.isRead && (
                          <button
                            disabled={pending}
                            onClick={() =>
                              startTransition(async () => {
                                try {
                                  await readAction(n.id);
                                  router.refresh();
                                } catch {
                                  setNoticeError(
                                    "Could not update this notification. Try again.",
                                  );
                                }
                              })
                            }
                          >
                            Mark read
                          </button>
                        )}
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="empty-state">
                    <Icon name="bell" />
                    <h3>You’re all caught up</h3>
                    <p>Case updates will appear here.</p>
                  </div>
                )}
                {noticeError && <p role="alert">{noticeError}</p>}
              </div>
            </details>
            <details className="popover">
              <summary className="user-trigger" aria-label="Account menu">
                <span className="avatar">
                  {email.slice(0, 2).toUpperCase()}
                </span>
                <Icon name="down" />
              </summary>
              <div className="popover-panel account-panel">
                <strong>{email}</strong>
                <p>{roles.join(" · ") || "No roles assigned"}</p>
                <SignOutButton signOutAction={signOutAction} />
              </div>
            </details>
          </div>
        </header>
        <div id="main-content" tabIndex={-1} className="workspace-content">
          {children}
        </div>
        <footer className="workspace-footer">
          <span>
            <Icon name="shield" /> Institution-scoped workspace
          </span>
          <span>CampusPulse · Campus compliance</span>
        </footer>
      </div>
      {searchDialog}
    </div>
  );
}
