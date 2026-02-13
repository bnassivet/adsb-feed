import type { Metadata } from "next";
import { AircraftTrackingProvider } from "@/contexts/AircraftTrackingContext";
import "./globals.css";

export const metadata: Metadata = {
  title: "ADS-B Aircraft Tracker",
  description: "Real-time aircraft tracking desktop application",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 antialiased">
        <AircraftTrackingProvider>
          {children}
        </AircraftTrackingProvider>
      </body>
    </html>
  );
}
