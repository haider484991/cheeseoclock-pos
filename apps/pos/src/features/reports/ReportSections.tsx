/**
 * The Reports page, section by section. Since costing Phase 3 each section
 * lives in the tab it belongs to (tabs/*.tsx), moved there unchanged, and
 * each tab loads only its own figures. They are re-exported here for
 * anything that imported them from this file.
 */
export { Summary } from './tabs/OverviewTab';
export { WhenSection } from './tabs/WhenTab';
export { ItemsSection } from './tabs/MenuTab';
export { ChannelsSection, DeliveriesSection } from './tabs/ChannelsTab';
export { FoodCostSection } from './tabs/FoodCostStockTab';
export { DiscountsSection, RefundsSection, StaffSection } from './tabs/TeamLeakageTab';
