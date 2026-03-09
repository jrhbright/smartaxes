import dynamic from "next/dynamic";

const SmartAxes = dynamic(() => import("../components/SmartAxes"), { ssr: false });

export default function Page() {
  return <SmartAxes />;
}
