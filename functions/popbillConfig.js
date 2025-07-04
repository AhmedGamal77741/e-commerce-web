const popbill = require('popbill');

popbill.config({
  LinkID: 'PANGECHOCOLATE',
  SecretKey: 'bEzp9rA6mtI0+PI1P22VtZsMtzAgtiAalDgN+y4pHY4=',
  IsTest: true,
  IPRestrictOnOff: false,
  UseStaticIP: false,
  UseLocalTimeYN: true,
});

module.exports = popbill.CashbillService();
