import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ComposeScreen } from "@/compose/screen";

export default function ComposeRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ComposeScreen />
    </HostRouteBootstrapBoundary>
  );
}
