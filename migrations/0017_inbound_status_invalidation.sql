-- Inbound journals are operational status inputs, including before a rollup
-- completes. Invalidate prior projections and fence concurrent refreshes.
UPDATE alias_routes SET status_generation = status_generation + 1;
DELETE FROM route_status_projection;

CREATE TRIGGER route_status_inbound_added AFTER INSERT ON inbound_deliveries BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;
CREATE TRIGGER route_status_inbound_changed AFTER UPDATE ON inbound_deliveries BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id IN (OLD.route_id, NEW.route_id);
  DELETE FROM route_status_projection WHERE route_id IN (OLD.route_id, NEW.route_id);
END;
CREATE TRIGGER route_status_inbound_removed AFTER DELETE ON inbound_deliveries BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = OLD.route_id;
  DELETE FROM route_status_projection WHERE route_id = OLD.route_id;
END;

CREATE TRIGGER route_status_inbound_recipient_added AFTER INSERT ON inbound_recipient_deliveries BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = (SELECT route_id FROM inbound_deliveries WHERE id = NEW.delivery_id);
  DELETE FROM route_status_projection WHERE route_id = (SELECT route_id FROM inbound_deliveries WHERE id = NEW.delivery_id);
END;
CREATE TRIGGER route_status_inbound_recipient_changed AFTER UPDATE ON inbound_recipient_deliveries BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id IN (SELECT route_id FROM inbound_deliveries WHERE id IN (OLD.delivery_id, NEW.delivery_id));
  DELETE FROM route_status_projection WHERE route_id IN (SELECT route_id FROM inbound_deliveries WHERE id IN (OLD.delivery_id, NEW.delivery_id));
END;
CREATE TRIGGER route_status_inbound_recipient_removed AFTER DELETE ON inbound_recipient_deliveries BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = (SELECT route_id FROM inbound_deliveries WHERE id = OLD.delivery_id);
  DELETE FROM route_status_projection WHERE route_id = (SELECT route_id FROM inbound_deliveries WHERE id = OLD.delivery_id);
END;
