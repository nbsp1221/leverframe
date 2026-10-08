import { SettingsReturnLink } from '../../../../src/components/connection-settings-link';
import { PageFrame } from '../../../../src/components/page-frame';
import { ConnectorWorkspace } from '../../../../src/features/connectors/connector-workspace';

export default function ConnectionSettingsPage() {
  return (
    <div className="flex flex-col gap-4">
      <PageFrame>
        <SettingsReturnLink />
      </PageFrame>
      <ConnectorWorkspace />
    </div>
  );
}
