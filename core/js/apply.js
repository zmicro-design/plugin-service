const path = require('path');
const $ = require('@znode/execa').$;
const fs = require('@znode/fs');
const spawn = require('child_process').spawn;
const parseArgs = require('yargs-parser');

const DEFAULT_SERVICE_CONFIG = path.join(process.cwd(), 'zmicro-service.yml');

async function apply(configFile = DEFAULT_SERVICE_CONFIG, options) {
  const cwd = process.cwd();
  const config = await fs.yml.load(configFile);
  if (!config.services) {
    throw new Error(`services is required`);
  }

  await applyNetworks(config.networks);

  if (options.name) {
    if (!config.services[options.name]) {
      throw new Error(`unknown service named ${options.name}`);
    }

    const service = {
      ...config.services[options.name],
      name: options.name,
    };

    return await applyService(service, config.networks, { ...options, cwd }); 
  }

  await applyServices(config.services, config.networks, { ...options, cwd })
}

async function applyNetworks(networks) {
  if (!networks) {
    throw new Error('networks is required');
  }

  console.log(await $`log::info "applying networks ..."`);
  const systemNetworks = await getSystemNetworks();

  for (const name in networks) {
    const network = {
      name,
      ...networks[name],
    };

    await applyNetwork(network, systemNetworks);
  }
}

async function applyNetwork(network, systemNetworks) {
  const { name, driver = 'bridge' } = network

  if (systemNetworks[name]) {
    // console.log(await $`log::info "network ${name} found ..."`);
    return ;
  }

  console.log(await $`log::info "create network ${name} ..."`);
  try {
    await $`docker network create -d ${driver} ${name}`;
    console.log(await $`log::success "success create network ${name}."`);
  } catch (error) {
    console.log(await $`log::error "failed to create network ${name} (${error.message})"`);
  }
}

async function applyServices(services, networks, options) {
  if (!services || !networks) {
    console.log(await $`log::info "services and networks is required ..."`);
  }

  console.log(await $`log::info "applying services ..."`);
  for (const name in services) {
    const service = {
      ...services[name],
      name,
    };

    await applyService(service, networks, options);
  }
}

async function applyService(service, networks, options) {
  // @TODO
  service.use = parseServiceUse(service);

  console.log(await $`log::info "[${service.name}][image: ${service.use.image}] applying service ..."`);

  // console.log(await $`log::info "[${service.name}] updating config ..."`);
  await applyServiceConfig(service, networks);

  if (!await isServiceExist(service.name)) {
    console.log(await $`log::info "[${service.name}][image: ${service.use.image}] apply installing ..."`);
    await runCommand(`SERVICE_AUTO_START=N zmicro service install ${service.use.image} ${service.use.version} ${service.name}`);
  } else {
    console.log(await $`log::info "[${service.name}][image: ${service.use.image}] apply updating ..."`);
    await runCommand(`zmicro service pull_repo ${service.use.image} ${service.use.version} ${service.name}`);
  }

  // if (!['notion', 'vscode', 'portainer'].includes(service.name)) return;

  const action = options && options.action || 'start';
  console.log(await $`log::info "[${service.name}][image: ${service.use.image}] ${action}ing ..."`);
  // await $`zmicro service start ${service.name}`;
  await runCommand(`zmicro service ${action} ${service.name}`);

  console.log(await $`log::info "[${service.name}][image: ${service.use.image}] done .\n"`);
}

async function isServiceExist(name) {
  const serviceDir = `/usr/local/lib/zmicro/plugins/service/services/${name}`;
  return fs.exist(serviceDir);
}

async function applyServiceConfig(service, networks) {
  const configDir = `/configs/plugins/service/config/${service.name}`;
  const configEnvPath = `${configDir}/config`;
  const configYmlPath = `${configDir}/config.yml`;

  await fs.mkdirp(configDir);

  const network = await getServiceNetwork(service.name, service.network, networks);
  const environment = {
    ...service.environment,
    _SERVICE_NETWORK: network, //
  };

  await applyServiceConfigEnvironment(service.use.image, environment, configEnvPath);

  await applyServiceConfigConfig(service.name, service.config, configYmlPath);
}

async function applyServiceConfigEnvironment(serviceName, environment, filepath) {
  console.log(await $`log::info "[${serviceName}] applying service environment ..."`);

  const envPrefix = `SERVICE_${serviceName.replace(/-/g, '_').toUpperCase()}`;
    const env = [];
    for (const key in environment) {
      let envKey = key;

      // if key start with _, it means use no prefix
      if (!/^_/.test(key)) {
        envKey = `${envPrefix}_${key}`;
      } else {
        envKey = key.slice(1);
      }
    
      const envValue = environment[key];
      env.push(`${envKey}="${envValue}"`);
    }

    await fs.writeFile(filepath, env.join('\n'));
}

async function applyServiceConfigConfig(serviceName, config, filepath) {
  console.log(await $`log::info "[${serviceName}] applying service config ..."`);

  if (config) {
    return ; 
  }

  await fs.yml.write(filepath, config);
}

async function getServiceNetwork(serviceName, serviceNetworkName, networks) {
  debug('[debug] networks:', networks)

  console.log(await $`log::info "[${serviceName}] applying service network ..."`);

  if (!serviceNetworkName) {
    return networks.default.name;
  }

  if (!networks[serviceNetworkName]) {
    throw new Error(`service network is not vaild, should be one of ${Object.keys(networks)}`);
  }

  return serviceNetworkName;
}

async function runCommand(command) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code !== 0) return reject(`command (${command}) error (${code})`);

      resolve();
    });
  });
}

async function getSystemNetworks() {
  const raw = await $`docker network ls`;
  
  debug('system networks:', raw);

  const lines = raw.split('\n').slice(1);
  const items = lines.map(_line => {
    const line = _line.replace(/\s+/g, ' ')
    const parts = line.split(' ');
    const id = parts[0].trim();
    const name = parts[1].trim();
    const driver = parts[2].trim();
    const scope = parts[3].trim();

    return {
      id,
      name,
      driver,
      scope,
    };
  });

  return items.reduce((all, item) => {
    all[item.name] = item;
    return all;
  }, {})
}

function parseServiceUse(service) {
  const use = {
    image: service.name,
    version: 'master',
  };

  if (service.use) {
    const _use = service.use.split('@');
    if (_use && _use[0]) {
      use.image = _use[0];
    }

    if (_use && _use[1]) {
      use.version = _use[1];
    }
  }

  return use;
}

function debug(...message) {
  if (process.env.DEBUG) {
    console.log('[DEBUG]', ...message);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // console.log('args:', args);

  let config = args.f || args.config || DEFAULT_SERVICE_CONFIG;
  let action = args.a || args.action || 'start';
  let name = args.n || args.name;

  if (typeof config !== 'string') {
    throw new Error(`invalid service apply config`);
  }

  if (typeof action !== 'string' || !['start', 'stop', 'restart'].includes(action)) {
    throw new Error(`invalid service apply action, should only start/stop/restart`);
  }

  if (!/^\//.test(config)) {
    config = path.join(process.cwd(), config);
  }

  await apply(config, { action, name });
}

main()
  .catch(error => {
    debug('apply error', error);
    
    console.error('apply error', error.message);
    
    process.exit(1);
  });