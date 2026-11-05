import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Genesys Auth Token Service",
  description: "Internal microservice for Genesys Cloud Bearer token retrieval",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
