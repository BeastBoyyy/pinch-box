// Shared headless-browser launcher for the tools. Uses the system Edge/Chrome (set PW_CHANNEL=chrome) on the real GPU;
// PW_SOFTWARE=1 forces SwiftShader (slow, for machines without a GPU).
import { chromium } from 'playwright';
export async function launch() {
  const args = ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'];
  if (process.env.PW_SOFTWARE === '1') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  else args.push('--use-angle=d3d11', '--enable-gpu');
  if (process.env.PW_INTEL !== '1') args.push('--force_high_performance_gpu'); // PW_INTEL=1: stay on the integrated GPU (governor stress tests)
  return chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge', headless: true, args });
}
