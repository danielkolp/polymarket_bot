import { TrendIcon } from "@/components/ui/trend-icon";
export default function TrendTest() {
  return (
    <div>
      <span data-up><TrendIcon value={5} size={16} /></span>
      <span data-down><TrendIcon value={-5} size={16} /></span>
      <span data-flat><TrendIcon value={0} size={16} /></span>
    </div>
  );
}
