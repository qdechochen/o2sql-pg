const { Pool } = require('pg');
const O2sql = require('o2sql');

function warpCommand(self, command) {
  command.execute = async function (client) {
    return await self.onExecuteHandler(this, client);
  };
  return command;
}

let seq = 0;

class O2sqlPg extends O2sql {
  constructor(config) {
    super();
    this.pool = new Pool(config);
    this.id = `${process.pid}:${seq++}`;
    this.debug = !!config.debug;
    this.query('select now() as "currentTime"').then(({ rows }) => {
      console.log(
        `[o2sql-pg:${this.id}]: init OK. remote time ${rows[0].currentTime}`
      );
    });
  }
  _log(info) {
    this.debug && console.log(`[o2sql-pg:${this.id}]:${info}`);
  }
  _dir(data) {
    this.debug && (console.log(`[o2sql-pg:${this.id}]`) || console.dir(data));
  }
  _error(msg, error) {
    this.debug &&
      (console.error(`[o2sql-pg:${this.id}]:${msg}`) || console.dir(error));
  }

  select() {
    return warpCommand(this, super.select(...arguments));
  }
  get() {
    return warpCommand(this, super.get(...arguments));
  }
  count() {
    return warpCommand(this, super.count(...arguments));
  }
  update() {
    return warpCommand(this, super.update(...arguments));
  }
  delete() {
    return warpCommand(this, super.delete(...arguments));
  }
  insert() {
    return warpCommand(this, super.insert(...arguments));
  }
  insertInto() {
    return warpCommand(this, super.insertInto(...arguments));
  }

  async onExecuteHandler(command, client) {
    const { sql: text, values } = command.toParams();
    this._dir({
      text,
      values,
    });
    const { rowCount, rows } = await (client ? client : this.pool).query({
      text,
      values,
    });
    rows.count = rowCount;

    let result;
    if (command instanceof O2sql.command.Count) {
      result = rows[0].count;
    } else {
      if (rows.length > 0) {
        let columns;
        if (command instanceof O2sql.command.Select) {
          columns = command.data.columns;
        } else if (
          command instanceof O2sql.command.Insert ||
          command instanceof O2sql.command.Update ||
          command instanceof O2sql.command.Delete
        ) {
          columns = command.data.returning;
        }

        const groups = columns.filter(t => t.group);
        if (groups.length > 0) {
          groups.forEach(g => {
            const group = {};
            g.fields = (g.fields || g.columns).map(f => {
              if (f instanceof Array) {
                const [column, alias] = f;
                f = alias || column;
              }
              return [
                g.prefix
                  ? g.prefix +
                    (g.separator ? g.separator + f : capFirstLetter(f))
                  : f,
                f,
              ];
            });
          });

          rows.forEach(r => {
            groups.forEach(g => {
              r[g.prefix] = {};
              g.fields.forEach(f => {
                r[g.prefix][f[1]] = r[f[0]];
                delete r[f[0]];
              });
            });
          });
        }
      }

      if (command instanceof O2sql.command.Insert) {
        if (rowCount === 0) {
          return null;
        } else if (command.data.values.length === 1) {
          result = rows.length > 0 ? rows[0] : {};
        } else {
          result = rows;
        }
      } else if (
        command instanceof O2sql.command.Update ||
        command instanceof O2sql.command.Delete
      ) {
        if (rowCount === 0) {
          return null;
        } else {
          result = rows;
        }
      } else if (command instanceof O2sql.command.Get) {
        result = rows.length > 0 ? rows[0] : null;
      } else if (command instanceof O2sql.command.Select) {
        result = rows;
      }
    }

    return result;
  }

  async query(text, values, client) {
    this._dir({ text, values });
    return await (client || this.pool).query(text, values);
  }

  async transaction(queries, client) {
    const transitionClient = client || (await this.pool.connect());
    let result, error;
    try {
      await transitionClient.query('BEGIN');
      this._log('TRANSACTION BEGINS.............');

      result = await queries(transitionClient);

      await transitionClient.query('COMMIT');
      this._log('TRANSACTION COMMITTED.............');
    } catch (e) {
      this._error(`TRANSACTION ERROR`, e);
      error = e;
      await transitionClient.query('ROLLBACK');
      this._log('TRANSACTION ROLLBACK.............');
    } finally {
      if (!client) {
        transitionClient.release();
      }
    }
    if (error) {
      throw error;
    } else {
      return result;
    }
  }
}

module.exports = function (config) {
  return new O2sqlPg(config);
};
