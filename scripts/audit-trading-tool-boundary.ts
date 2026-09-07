/** Characterization only: no HTTP requests or actual tool execution. */
import { PrismProxyService } from '../src/services/prism/PrismProxyService.ts';
const id='offline-memory-audit:known';
PrismProxyService.registerSession(id,['get_market_data']);
const evidence={known_allowed:PrismProxyService.isToolAllowed(id,'get_market_data'),known_blocked:PrismProxyService.isToolAllowed(id,'schedule_research'),unknown_allows:PrismProxyService.isToolAllowed('offline-memory-audit:unknown','schedule_research'),missing_id_allows:PrismProxyService.isToolAllowed(undefined as any,'schedule_research')};
if(!evidence.known_allowed||evidence.known_blocked||!evidence.unknown_allows||!evidence.missing_id_allows)throw new Error('Audit characterization changed; reread implementation');
process.stdout.write(JSON.stringify(evidence,null,2)+'\n');
