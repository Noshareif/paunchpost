import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "PaunchPost",
  icons: { icon: "/paunchpost-cat.jpg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app">
          <aside className="side">
            <div className="brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="logo-cat" src="/paunchpost-cat.jpg" alt="PaunchPost cat" />
              <div>
                PaunchPost<small>by Darkhorse Tech</small>
              </div>
            </div>
            <nav className="nav">
              <Link href="/status" className="on">
                <span className="ico">⌂</span>Status
              </Link>
              <div className="nav-label">Coming next</div>
              <a className="off">Campaigns</a>
              <a className="off">Audience</a>
              <a className="off">Analytics</a>
            </nav>
            <div className="side-foot">Sends through Amazon SES</div>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
