-- Phase 26: a member's lab discount / free home collection is a negative DISCOUNT line on the order
ALTER TABLE lab_order_lines DROP CONSTRAINT lab_order_lines_kind_check;
ALTER TABLE lab_order_lines ADD CONSTRAINT lab_order_lines_kind_check CHECK (kind IN ('TEST','PACKAGE','HOME_VISIT','DISCOUNT'));
