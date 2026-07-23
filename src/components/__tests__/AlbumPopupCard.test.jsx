import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AlbumPopupCard from "../AlbumPopupCard.jsx";

describe("AlbumPopupCard", () => {
  it("renders the artist, track, place, and album art", () => {
    render(
      <AlbumPopupCard
        imageUrl="https://example.com/a.jpg"
        trackName="Idioteque"
        artistName="Radiohead"
        placeName="Oxford, England"
      />,
    );
    expect(screen.getByText("Radiohead")).toBeInTheDocument();
    expect(screen.getByText("Idioteque")).toBeInTheDocument();
    expect(screen.getByText(/Oxford, England/)).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://example.com/a.jpg",
    );
  });

  it("falls back to Unknown location and omits the image when data is missing", () => {
    render(<AlbumPopupCard trackName="X" artistName="Y" />);
    expect(screen.getByText(/Unknown location/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
