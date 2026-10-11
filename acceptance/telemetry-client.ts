// The form submits every field. This test-only client exercises partial updates
// through the production validator, observer, SDK hooks, and preload bridge.
import {getClient} from '../packages/contract/dist/client.js';
import {initializeRendererTelemetry} from '../packages/interface/src/application/telemetry';

const configuration = await getClient().telemetry.status();
if (configuration.status !== 'success' || !configuration.value.activeDsn) {
  throw new Error('Monitoring must be active for the telemetry client.');
}

const {activeDsn, activeSampling, environment} = configuration.value;
const monitoring = initializeRendererTelemetry(activeDsn, activeSampling, environment);
Reflect.set(window, 'acceptanceTelemetryClient', getClient(monitoring.observe));
