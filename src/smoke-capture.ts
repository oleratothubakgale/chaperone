import { captureOrder } from './paypal.js';

const id = process.argv[2];
if (!id) {
  console.error('Usage: npm run smoke:capture -- <ORDER_ID>');
  process.exit(1);
}
const order = await captureOrder(id);
console.log('Order ID:', order.id);
console.log('Status:  ', order.status);