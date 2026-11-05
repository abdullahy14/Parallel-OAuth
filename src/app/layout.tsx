import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Genesys Cloud — Token Auth",
  description: "Secure token authentication portal for Genesys Cloud via Microsoft Entra ID SSO",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: "#0a0f1e" }}>
        {children}
      </body>
    </html>
  );
}
