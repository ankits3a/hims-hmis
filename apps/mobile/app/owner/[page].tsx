import { Redirect, useLocalSearchParams } from "expo-router";
import { OwnerPage } from "../../src/screens/owner-page";
import { ownerTilesFor, type OwnerTileKey } from "../../src/owner/model";
import { useSession } from "../../src/session";

/**
 * A page behind one of the owner's tiles (owner 2026-10-09). Only for a signed-in person whose home
 * HAS that tile: a doctor or a cashier who types the address lands back on their own home, and the
 * Medical Superintendent has no Money page. The server refuses the reads as well.
 */
export default function Page() {
  const { page } = useLocalSearchParams<{ page: string }>();
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  const mine = ownerTilesFor(state.me.permissions.hospital);
  if (mine === null || !mine.includes(page as OwnerTileKey)) return <Redirect href="/" />;
  return <OwnerPage page={page as OwnerTileKey} />;
}
