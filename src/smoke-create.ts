import { createOrder, approvalLink } from './paypal.js';

const order = await createOrder('5.00', 'Chaperone smoke test');
console.log('Order ID:', order.id);
console.log('Status:  ', order.status);
console.log('Approve this link in your browser as the sandbox buyer:');
console.log(approvalLink(order) ?? '(no approval link returned)');