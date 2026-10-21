const { withAndroidManifest } = require('@expo/config-plugins');

function withWearOs(config) {
  return withAndroidManifest(config, (configWithManifest) => {
    const manifest = configWithManifest.modResults.manifest;
    const features = manifest['uses-feature'] || [];
    const application = manifest.application?.[0];
    const hasWatchFeature = features.some(
      (feature) => feature.$?.['android:name'] === 'android.hardware.type.watch'
    );

    if (!hasWatchFeature) {
      features.push({
        $: {
          'android:name': 'android.hardware.type.watch',
          'android:required': 'true'
        }
      });
    }

    manifest['uses-feature'] = features;

    if (application) {
      application.$ = application.$ || {};
      application.$['android:usesCleartextTraffic'] = 'true';
    }

    return configWithManifest;
  });
}

module.exports = withWearOs;
