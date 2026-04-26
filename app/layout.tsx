import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Unfiltered — Honest user research, on demand",
  description:
    "Always-on AI voice interviewer for multimodal user research. Synthetic users for pre-flight, real interviews on demand, evidence-grounded findings.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
