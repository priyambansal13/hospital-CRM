-- Phase 26: a booking that used a membership benefit (FREE_VIDEO: one of the month's free video consults)
ALTER TABLE appointments ADD COLUMN member_benefit text CHECK (member_benefit IN ('FREE_VIDEO'));
